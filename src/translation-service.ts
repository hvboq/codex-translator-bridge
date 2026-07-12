import { createHash } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { StructuredRunner } from './app-server-client.js';
import { TranslationCache } from './cache.js';
import {
  buildBatchPrompt,
  translationSchema,
} from './prompt.js';
import { protectPlaceholders, restorePlaceholders, type Placeholder } from './placeholders.js';
import type {
  CodexModel,
  TranslationItem,
  TranslationRequest,
  TranslationResult,
} from './types.js';

export class InputError extends Error {}

interface QueueEntry<T> {
  item: T;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

class MicroBatcher<T> {
  private pending: Array<QueueEntry<T>> = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    private readonly maxItems: number,
    private readonly windowMs: number,
    private readonly batchKey: (item: T) => string,
    private readonly processBatch: (items: T[]) => Promise<string[]>,
  ) {}

  enqueue(item: T): Promise<string> {
    if (this.pending.length >= this.maxItems * 64) {
      return Promise.reject(new Error('Translation queue is full'));
    }
    const promise = new Promise<string>((resolve, reject) => {
      this.pending.push({ item, resolve, reject });
    });
    this.schedule();
    return promise;
  }

  private schedule(): void {
    if (this.timer || this.flushing || this.pending.length === 0) {
      return;
    }
    const delay = this.pending.length >= this.maxItems ? 0 : this.windowMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) {
      return;
    }
    this.flushing = true;
    const first = this.pending[0];
    if (!first) {
      this.flushing = false;
      return;
    }
    const key = this.batchKey(first.item);
    const entries: Array<QueueEntry<T>> = [];
    const remaining: Array<QueueEntry<T>> = [];
    for (const entry of this.pending) {
      if (entries.length < this.maxItems && this.batchKey(entry.item) === key) {
        entries.push(entry);
      } else {
        remaining.push(entry);
      }
    }
    this.pending = remaining;
    try {
      const results = await this.processBatch(entries.map((entry) => entry.item));
      if (results.length !== entries.length) {
        throw new Error('Codex returned an unexpected translation count');
      }
      entries.forEach((entry, index) => entry.resolve(results[index] as string));
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      entries.forEach((entry) => entry.reject(normalized));
    } finally {
      this.flushing = false;
      this.schedule();
    }
  }
}

export class TranslationService {
  private readonly translationBatcher: MicroBatcher<TranslationItem>;
  private readonly inflightTranslations = new Map<string, Promise<string>>();

  constructor(
    private readonly config: AppConfig,
    private readonly runner: StructuredRunner,
    private readonly cache: TranslationCache,
  ) {
    this.translationBatcher = new MicroBatcher(
      config.maxBatchItems,
      config.batchWindowMs,
      (item) => item.runtimeModel,
      (items) => this.processTranslationBatch(items),
    );
  }

  async listModels(): Promise<CodexModel[]> {
    return (await this.runner.listModels()).filter(
      (model) => /^gpt-5\.6(?:-|$)/i.test(model.model) && model.hidden !== true,
    );
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const startedAt = Date.now();
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new InputError('Request body must be an object');
    }
    const texts = normalizeTexts(request.text);
    const source = firstNonEmpty(
      optionalString(request.source, 'source'),
      optionalString(request.source_lang, 'source_lang'),
      this.config.defaultSource,
    );
    const target = firstNonEmpty(
      optionalString(request.target, 'target'),
      optionalString(request.target_lang, 'target_lang'),
      this.config.defaultTarget,
    );
    const context = normalizeContext(request.context);
    const glossary = normalizeGlossary(request.glossary);
    const style = optionalString(request.style, 'style')?.trim() || 'natural game dialogue';
    const requestedModel = normalizeRequestedModel(request.model);

    const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
    if (totalChars > this.config.maxTextChars) {
      throw new InputError('Text exceeds the configured character limit');
    }
    if (texts.length > this.config.maxBatchItems) {
      throw new InputError('Too many texts in one request');
    }
    const selectedModel = await this.runner.resolveModel(requestedModel);

    const cached: boolean[] = [];
    const promises = texts.map((text) => {
      if (text.trim() === '') {
        cached.push(true);
        return Promise.resolve(text);
      }
      const item = createItem(text, source, target, context, glossary, style, selectedModel);
      const hit = this.cache.get(item.key);
      if (hit !== undefined) {
        cached.push(true);
        return Promise.resolve(hit);
      }
      cached.push(false);
      const existing = this.inflightTranslations.get(item.key);
      if (existing) {
        return existing;
      }
      const pending = this.translationBatcher
        .enqueue(item)
        .then(async (value) => {
          await this.cache.set(item.key, value);
          return value;
        })
        .finally(() => this.inflightTranslations.delete(item.key));
      this.inflightTranslations.set(item.key, pending);
      return pending;
    });

    return {
      translations: await Promise.all(promises),
      cached,
      durationMs: Date.now() - startedAt,
      model: selectedModel.id,
    };
  }

  private async processTranslationBatch(items: TranslationItem[]): Promise<string[]> {
    const first = items[0];
    if (!first) {
      return [];
    }
    return this.withOneRetry(async () => {
      const response = await this.runner.runStructured(
        buildBatchPrompt(items),
        translationSchema(items.length),
        { id: first.model, model: first.runtimeModel },
      );
      const parsed = parseObject(response);
      const outputs = validateStringArray(parsed.translations, items.length, 'translations');
      return outputs.map((output, index) =>
        restorePlaceholders(output, items[index]?.placeholders ?? []),
      );
    });
  }

  private async withOneRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/invalid JSON|invalid structured|invalid .* array|protected placeholder/i.test(message)) {
        throw error;
      }
      return operation();
    }
  }
}

function normalizeTexts(value: unknown): string[] {
  const texts = Array.isArray(value) ? value : [value];
  if (texts.length === 0 || texts.some((text) => typeof text !== 'string')) {
    throw new InputError('text must be a string or a non-empty string array');
  }
  return texts as string[];
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new InputError(name + ' must be a string');
  }
  return value;
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

function normalizeContext(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  const context = Array.isArray(value) ? value : [value];
  if (context.some((entry) => typeof entry !== 'string')) {
    throw new InputError('context must contain only strings');
  }
  return (context as string[]).slice(-20);
}

function normalizeGlossary(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError('glossary must be an object');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, translated]) => typeof translated !== 'string')) {
    throw new InputError('glossary values must be strings');
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => value?.trim())?.trim() ?? '';
}

function createItem(
  text: string,
  source: string,
  target: string,
  context: string[],
  glossary: Record<string, string>,
  style: string,
  selectedModel: CodexModel,
): TranslationItem {
  const protectedText = protectPlaceholders(text);
  const identity = {
    kind: 'translation-v2',
    text,
    source,
    target,
    context,
    glossary,
    style,
    model: selectedModel.model,
  };
  return {
    key: digest(identity),
    model: selectedModel.id,
    runtimeModel: selectedModel.model,
    text: protectedText.text,
    source,
    target,
    context,
    glossary,
    style,
    placeholders: protectedText.placeholders,
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function parseObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Codex returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex returned an invalid structured response');
  }
  return parsed as Record<string, unknown>;
}

function validateStringArray(value: unknown, count: number, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Codex returned an invalid ' + name + ' array');
  }
  return value as string[];
}
