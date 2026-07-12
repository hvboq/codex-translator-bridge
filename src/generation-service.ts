import type { AppConfig } from './config.js';
import {
  ModelUnavailableError,
  type StructuredRunner,
  type TextRunOptions,
} from './app-server-client.js';
import { InputError } from './translation-service.js';
import type {
  ChatMessage,
  CodexModel,
  RequestedReasoning,
  TextGenerationResult,
} from './types.js';

export interface PreparedGeneration {
  historyItems: Array<Record<string, unknown>>;
  input: string;
  messages: ChatMessage[];
  model: CodexModel;
  reasoningEffort: string;
  reasoningFallback?: string;
}

export type GenerationRunOptions = TextRunOptions;

const MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'assistant']);
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text']);
const REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

export class GenerationService {
  private activeGenerations = 0;
  private readonly generationQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly runner: StructuredRunner,
  ) {}

  async prepareChat(
    messages: unknown,
    requestedModel?: unknown,
    reasoning: RequestedReasoning = {},
  ): Promise<PreparedGeneration> {
    return this.prepare(normalizeMessages(messages, 'messages'), requestedModel, reasoning);
  }

  async prepareResponse(
    input: unknown,
    instructions?: unknown,
    requestedModel?: unknown,
    reasoning: RequestedReasoning = {},
  ): Promise<PreparedGeneration> {
    const messages = normalizeResponseInput(input);
    if (instructions !== undefined) {
      if (typeof instructions !== 'string') {
        throw new InputError('instructions must be a string');
      }
      messages.unshift({ role: 'developer', content: instructions });
    }
    return this.prepare(messages, requestedModel, reasoning);
  }

  async generate(
    prepared: PreparedGeneration,
    options: GenerationRunOptions = {},
  ): Promise<TextGenerationResult> {
    await this.acquireGenerationSlot(options.signal);
    try {
      const maxOutputChars = this.config.maxTextChars * 4;
      let streamedChars = 0;
      const {
        reasoningEffort: _reasoningEffort,
        ...runOptions
      } = options;
      const result = await this.runner.runText(
        prepared.input,
        { id: prepared.model.id, model: prepared.model.model },
        {
          ...runOptions,
          historyItems: prepared.historyItems,
          reasoningEffort: prepared.reasoningEffort,
          onDelta: (delta) => {
            streamedChars += delta.length;
            if (streamedChars > maxOutputChars) {
              throw new Error('Codex output exceeded the configured safety limit');
            }
            options.onDelta?.(delta);
          },
        },
      );
      if (result.content.length > maxOutputChars) {
        throw new Error('Codex output exceeded the configured safety limit');
      }
      return { content: result.content, model: prepared.model.id, usage: result.usage };
    } finally {
      this.releaseGenerationSlot();
    }
  }

  private async prepare(
    messages: ChatMessage[],
    requestedModelValue?: unknown,
    reasoning: RequestedReasoning = {},
  ): Promise<PreparedGeneration> {
    const serialized = JSON.stringify(messages);
    if (serialized.length > this.config.maxTextChars * 2) {
      throw new InputError('Messages exceed the configured character limit');
    }
    const requestedModel = normalizeRequestedModel(requestedModelValue);
    const model = await this.runner.resolveModel(requestedModel);
    const resolvedReasoning = resolveReasoningEffort(
      model,
      this.config.reasoningEffort,
      reasoning,
    );
    const finalMessage = messages.at(-1);
    if (!finalMessage || finalMessage.role !== 'user' || typeof finalMessage.content !== 'string') {
      throw new InputError('The final message must be a user text message');
    }
    return {
      historyItems: messages.slice(0, -1).map(toHistoryItem),
      input: finalMessage.content,
      messages,
      model,
      reasoningEffort: resolvedReasoning.effort,
      ...(resolvedReasoning.fallback
        ? { reasoningFallback: resolvedReasoning.fallback }
        : {}),
    };
  }

  private acquireGenerationSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Codex generation was cancelled'));
    }
    if (this.activeGenerations < this.config.maxConcurrentGenerations) {
      this.activeGenerations += 1;
      return Promise.resolve();
    }
    if (this.generationQueue.length >= this.config.maxConcurrentGenerations * 64) {
      return Promise.reject(new Error('Generation queue is full'));
    }
    return new Promise<void>((resolve, reject) => {
      const entry: {
        resolve: () => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        abort?: () => void;
      } = { resolve, reject, signal };
      this.generationQueue.push(entry);
      if (signal) {
        entry.abort = () => {
          const index = this.generationQueue.indexOf(entry);
          if (index >= 0) {
            this.generationQueue.splice(index, 1);
            reject(new Error('Codex generation was cancelled'));
          }
        };
        signal.addEventListener('abort', entry.abort, { once: true });
        if (signal.aborted) {
          entry.abort();
        }
      }
    });
  }

  private releaseGenerationSlot(): void {
    this.activeGenerations = Math.max(0, this.activeGenerations - 1);
    while (this.generationQueue.length > 0) {
      const next = this.generationQueue.shift();
      if (!next) {
        return;
      }
      if (next.abort) {
        next.signal?.removeEventListener('abort', next.abort);
      }
      if (next.signal?.aborted) {
        next.reject(new Error('Codex generation was cancelled'));
        continue;
      }
      this.activeGenerations += 1;
      next.resolve();
      return;
    }
  }
}

export function normalizeReasoningEffort(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new InputError(field + ' must be a reasoning effort string or null');
  }
  const lowered = value.trim().toLowerCase();
  const normalized = lowered === 'xhign' ? 'xhigh' : lowered;
  if (!REASONING_EFFORTS.has(normalized)) {
    throw new InputError(
      field + ' must be one of none, minimal, low, medium, high, xhigh, max, or ultra',
    );
  }
  return normalized;
}

function resolveReasoningEffort(
  model: CodexModel,
  configuredEffort: string,
  reasoning: RequestedReasoning,
): { effort: string; fallback?: string } {
  const explicitEffort = normalizeReasoningEffort(reasoning.effort, 'reasoning effort');
  if (reasoning.thinking === 'enabled' && explicitEffort === 'none') {
    throw new InputError('thinking.type=enabled cannot be combined with reasoning effort "none"');
  }
  const requestControlled = explicitEffort !== undefined || reasoning.thinking === 'disabled';
  const configured = configuredEffort.toLowerCase();
  const requestedEffort = reasoning.thinking === 'disabled'
    ? 'none'
    : reasoning.thinking === 'enabled' && explicitEffort === undefined && configured === 'none'
      ? 'minimal'
      : explicitEffort ?? configured;
  const supported = model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
  if (supported.length === 0) {
    return { effort: requestedEffort };
  }
  const supportedNames = new Set(supported.map((effort) => effort.toLowerCase()));
  if (supportedNames.has(requestedEffort)) {
    return { effort: requestedEffort };
  }
  const allowFallback = reasoning.thinking === 'disabled' || explicitEffort === undefined;
  const fallbackNames = allowFallback
    ? requestedEffort === 'none'
      ? ['minimal', 'low']
      : requestedEffort === 'minimal'
        ? ['low']
        : []
    : [];
  for (const fallbackName of fallbackNames) {
    if (supportedNames.has(fallbackName)) {
      return {
        effort: fallbackName,
        fallback:
          (reasoning.thinking ? 'thinking.' + reasoning.thinking + ':' : '') +
          requestedEffort +
          '->' +
          fallbackName,
      };
    }
  }
  const message =
    'Reasoning effort "' +
    requestedEffort +
    '" is not supported by ' +
    model.id +
    '. Supported values: ' +
    supported.join(', ');
  if (requestControlled) {
    throw new InputError(message);
  }
  throw new ModelUnavailableError(message);
}

function normalizeResponseInput(input: unknown): ChatMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new InputError('input must be a string or a non-empty message array');
  }
  const messages = input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new InputError('input[' + index + '] must be a message object');
    }
    const raw = item as Record<string, unknown>;
    if (raw.type !== undefined && raw.type !== 'message') {
      throw new InputError('Only text message input items are supported');
    }
    return normalizeMessage(raw, 'input[' + index + ']');
  });
  return messages;
}

function normalizeMessages(value: unknown, field: string): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InputError(field + ' must be a non-empty array');
  }
  return value.map((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new InputError(field + '[' + index + '] must be a message object');
    }
    return normalizeMessage(message as Record<string, unknown>, field + '[' + index + ']');
  });
}

function normalizeMessage(raw: Record<string, unknown>, field: string): ChatMessage {
  if (typeof raw.role !== 'string' || !MESSAGE_ROLES.has(raw.role)) {
    throw new InputError(
      field + '.role must be system, developer, user, or assistant',
    );
  }
  const content = normalizeContent(raw.content, field + '.content');
  const message: ChatMessage = { role: raw.role, content };
  if (raw.name !== undefined) {
    throw new InputError(field + '.name is not supported');
  }
  return message;
}

function toHistoryItem(message: ChatMessage): Record<string, unknown> {
  const assistant = message.role === 'assistant';
  return {
    type: 'message',
    role: message.role,
    content: [
      {
        type: assistant ? 'output_text' : 'input_text',
        text: message.content,
      },
    ],
  };
}

function normalizeContent(value: unknown, field: string): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new InputError(field + ' must be text or a non-empty text-part array');
  }
  return value.map((part, index) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new InputError(field + '[' + index + '] must be a text part');
    }
    const raw = part as Record<string, unknown>;
    if (typeof raw.type !== 'string' || !TEXT_PART_TYPES.has(raw.type)) {
      throw new InputError('Only text content parts are supported');
    }
    if (typeof raw.text !== 'string') {
      throw new InputError(field + '[' + index + '].text must be a string');
    }
    return raw.text;
  }).join('');
}

function normalizeRequestedModel(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new InputError('model must be a string');
  }
  const model = value.trim();
  if (!model) {
    throw new InputError('model must not be empty');
  }
  return model;
}
