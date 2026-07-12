import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import type { AppConfig } from './config.js';
import type {
  AppStatus,
  CodexModel,
  CodexModelSelection,
  CodexReasoningEffort,
  TokenUsage,
} from './types.js';
import {
  BRIDGE_BASE_INSTRUCTIONS,
  BRIDGE_DEVELOPER_INSTRUCTIONS,
  TRANSLATOR_BASE_INSTRUCTIONS,
  TRANSLATOR_DEVELOPER_INSTRUCTIONS,
} from './prompt.js';

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TurnWaiter {
  messages: string[];
  streamingItemIds: Set<string>;
  onDelta?: (delta: string) => void;
  removeAbortListener?: () => void;
  usage: TokenUsage | null;
  resolve: (value: TextRunResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

export interface StructuredRunner {
  listModels(): Promise<CodexModel[]>;
  resolveModel(requested?: string): Promise<CodexModel>;
  runStructured(
    prompt: string,
    outputSchema: object,
    selection: CodexModelSelection,
  ): Promise<string>;
  runText(
    prompt: string,
    selection: CodexModelSelection,
    options?: TextRunOptions,
  ): Promise<TextRunResult>;
}

export interface TextRunResult {
  content: string;
  usage: TokenUsage | null;
}

export interface TextRunOptions {
  historyItems?: Array<Record<string, unknown>>;
  onDelta?: (delta: string) => void;
  onReady?: () => void | Promise<void>;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

export class UnsupportedModelError extends Error {
  constructor(
    requested: string,
    readonly supportedModels: string[],
  ) {
    super(
      'Unsupported model "' +
        requested +
        '". Available GPT-5.6 models: ' +
        (supportedModels.join(', ') || 'none'),
    );
    this.name = 'UnsupportedModelError';
  }
}

export class ModelUnavailableError extends Error {
  constructor(message = 'No GPT-5.6 model is available for the current Codex account') {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

const MODEL_CACHE_TTL_MS = 60_000;
const GPT_56_MODEL_PATTERN = /^gpt-5\.6(?:-|$)/i;
const DEFAULT_MODEL_ALIASES = new Set(['codex-bridge', 'codex-translator']);

export class CodexAppServerClient implements StructuredRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turns = new Map<string, TurnWaiter>();
  private stopping = false;
  private status: AppStatus = { ready: false, authMode: null, planType: null };
  private modelCatalog: { models: CodexModel[]; expiresAt: number } | null = null;
  private modelCatalogPromise: Promise<CodexModel[]> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly log: (message: string) => void = console.log,
  ) {}

  async getStatus(): Promise<AppStatus> {
    try {
      await this.ensureStarted();
      return { ...this.status };
    } catch (error) {
      return {
        ready: false,
        authMode: null,
        planType: null,
        error: errorMessage(error),
      };
    }
  }

  async listModels(): Promise<CodexModel[]> {
    await this.ensureStarted();
    if (!this.status.ready) {
      throw new Error(this.status.error ?? 'Codex is not authenticated');
    }

    if (this.modelCatalog && this.modelCatalog.expiresAt > Date.now()) {
      return this.modelCatalog.models.map(cloneModel);
    }
    if (this.modelCatalogPromise) {
      return (await this.modelCatalogPromise).map(cloneModel);
    }

    const loading = this.loadModelCatalog();
    this.modelCatalogPromise = loading;
    try {
      const models = await loading;
      this.modelCatalog = {
        models,
        expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
      };
      return models.map(cloneModel);
    } finally {
      if (this.modelCatalogPromise === loading) {
        this.modelCatalogPromise = null;
      }
    }
  }

  async resolveModel(requested?: string): Promise<CodexModel> {
    return resolveGpt56Model(await this.listModels(), requested, this.config.model);
  }

  async runStructured(
    prompt: string,
    outputSchema: object,
    selection: CodexModelSelection,
  ): Promise<string> {
    return (await this.runTurn(prompt, selection, outputSchema, {}, true)).content;
  }

  async runText(
    prompt: string,
    selection: CodexModelSelection,
    options: TextRunOptions = {},
  ): Promise<TextRunResult> {
    return this.runTurn(prompt, selection, undefined, options);
  }

  private async runTurn(
    prompt: string,
    selection: CodexModelSelection,
    outputSchema?: object,
    options: TextRunOptions = {},
    translationMode = false,
  ): Promise<TextRunResult> {
    if (options.signal?.aborted) {
      throw new Error('Codex generation was cancelled');
    }
    const selectedModel = await this.resolveModel(selection.id);
    if (selectedModel.model !== selection.model) {
      throw new ModelUnavailableError(
        'Resolved model mapping changed for "' + selection.id + '"; retry the request',
      );
    }
    const reasoningEffort = options.reasoningEffort === undefined
      ? resolveRunReasoningEffort(selectedModel, this.config.reasoningEffort)
      : options.reasoningEffort;
    assertReasoningEffortSupported(selectedModel, reasoningEffort);
    if (options.signal?.aborted) {
      throw new Error('Codex generation was cancelled');
    }

    const started = await this.request<{
      thread: { id: string };
    }>(
      'thread/start',
      {
        model: selectedModel.model,
        cwd: this.config.runtimeDirectory,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        serviceName: 'codex_bridge',
        baseInstructions: translationMode
          ? TRANSLATOR_BASE_INSTRUCTIONS
          : BRIDGE_BASE_INSTRUCTIONS,
        developerInstructions: translationMode
          ? TRANSLATOR_DEVELOPER_INSTRUCTIONS
          : BRIDGE_DEVELOPER_INSTRUCTIONS,
        config: {
          web_search: 'disabled',
          mcp_servers: {},
          features: {
            apps: false,
            plugins: false,
            browser_use: false,
            in_app_browser: false,
            computer_use: false,
            image_generation: false,
            memories: false,
            multi_agent: false,
            workspace_dependencies: false,
            goals: false,
            shell_tool: false,
            unified_exec: false,
            hooks: false,
            tool_suggest: false,
          },
        },
      },
      20_000,
    );
    const threadId = started.thread.id;
    if (options.signal?.aborted) {
      void this.request('thread/unsubscribe', { threadId }, 5_000).catch(() => undefined);
      throw new Error('Codex generation was cancelled');
    }
    if (options.historyItems?.length) {
      try {
        await this.request(
          'thread/inject_items',
          { threadId, items: options.historyItems },
          20_000,
        );
      } catch (error) {
        void this.request('thread/unsubscribe', { threadId }, 5_000).catch(() => undefined);
        throw error;
      }
    }
    try {
      await options.onReady?.();
    } catch (error) {
      void this.request('thread/unsubscribe', { threadId }, 5_000).catch(() => undefined);
      throw error;
    }
    const result = this.waitForTurn(threadId, options);
    void result.catch(() => undefined);

    try {
      if (options.signal?.aborted) {
        throw new Error('Codex generation was cancelled');
      }
      const turnParams: Record<string, unknown> = {
        threadId,
        input: [{ type: 'text', text: prompt }],
        effort: reasoningEffort,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          networkAccess: false,
        },
      };
      if (outputSchema !== undefined) {
        turnParams.outputSchema = outputSchema;
      }
      await this.request(
        'turn/start',
        turnParams,
        20_000,
      );
      return await result;
    } catch (error) {
      void this.request('turn/interrupt', { threadId }, 5_000).catch(() => undefined);
      this.rejectTurn(threadId, error instanceof Error ? error : new Error(String(error)));
      await result.catch(() => undefined);
      throw error;
    } finally {
      void this.request('thread/unsubscribe', { threadId }, 5_000).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.lineReader?.close();
    this.lineReader = null;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
    this.failAll(new Error('Codex app-server stopped'));
    this.startPromise = null;
    this.status = { ready: false, authMode: null, planType: null };
    this.clearModelCatalog();
  }

  private async loadModelCatalog(): Promise<CodexModel[]> {
    return collectGpt56ModelCatalog(async (cursor) => {
      const params: Record<string, unknown> = { limit: 100, includeHidden: false };
      if (cursor !== undefined) {
        params.cursor = cursor;
      }
      return this.request<{
        data?: unknown;
        nextCursor?: unknown;
      }>('model/list', params, 20_000);
    });
  }

  private clearModelCatalog(): void {
    this.modelCatalog = null;
    this.modelCatalogPromise = null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.startPromise === null) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.lineReader?.close();
      this.lineReader = null;
      const child = this.child;
      this.child = null;
      if (child && !child.killed) {
        child.kill();
      }
      this.status = {
        ready: false,
        authMode: null,
        planType: null,
        error: normalized.message,
      };
      this.failAll(normalized);
      throw normalized;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
    const require = createRequire(import.meta.url);
    const launcher = require.resolve('@openai/codex/bin/codex.js');
    const child = spawn(process.execPath, [launcher, 'app-server', '--listen', 'stdio://'], {
      env: {
        ...process.env,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_bridge',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    this.lineReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lineReader.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) {
        this.log('[codex] ' + message);
      }
    });
    child.once('error', (error) => this.handleExit(error, child));
    child.once('exit', (code, signal) => {
      this.handleExit(
        new Error('Codex app-server exited (' + (code ?? signal ?? 'unknown') + ')'),
        child,
      );
    });

    await this.requestRaw(
      'initialize',
      {
        clientInfo: {
          name: 'codex_bridge',
          title: 'Codex Bridge',
          version: '0.2.0',
        },
        capabilities: {
          experimentalApi: false,
        },
      },
      20_000,
    );
    this.notify('initialized', {});

    const account = await this.requestRaw<{
      account: { type?: string; planType?: string | null } | null;
      requiresOpenaiAuth: boolean;
    }>('account/read', { refreshToken: false }, 20_000);
    const authMode = account.account?.type ?? null;
    const ready = account.requiresOpenaiAuth ? account.account !== null : true;
    this.status = {
      ready,
      authMode,
      planType: account.account?.planType ?? null,
      error: ready ? undefined : 'Run npm run codex:login before using Codex Bridge',
    };
  }

  private request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    if (!this.child) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
    return this.requestRaw<T>(method, params, timeoutMs);
  }

  private requestRaw<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex request timed out: ' + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Codex app-server stdin is unavailable');
    }
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.log('[codex] Ignored malformed JSON-RPC line');
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'Codex JSON-RPC error'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.handleNotification(message.method, message.params ?? {});
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (method === 'thread/tokenUsage/updated' && threadId) {
      const tokenUsage = params.tokenUsage as {
        last?: Partial<TokenUsage>;
      } | undefined;
      const last = tokenUsage?.last;
      if (last && isTokenUsage(last)) {
        const waiter = this.turns.get(threadId);
        if (waiter && !waiter.settled) {
          waiter.usage = { ...last };
        }
      }
      return;
    }
    if (method === 'item/started' && threadId) {
      const item = params.item as {
        id?: string;
        type?: string;
        phase?: string | null;
      } | undefined;
      if (item?.type === 'agentMessage' && item.phase === 'final_answer' && item.id) {
        this.turns.get(threadId)?.streamingItemIds.add(item.id);
      }
      return;
    }
    if (method === 'item/agentMessage/delta' && threadId) {
      const delta = typeof params.delta === 'string' ? params.delta : undefined;
      const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
      const waiter = this.turns.get(threadId);
      if (
        delta &&
        itemId &&
        waiter &&
        waiter.streamingItemIds.has(itemId) &&
        !waiter.settled
      ) {
        try {
          waiter.onDelta?.(delta);
        } catch (error) {
          void this.request('turn/interrupt', { threadId }, 5_000).catch(() => undefined);
          this.rejectTurn(
            threadId,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      return;
    }
    if (method === 'item/completed' && threadId) {
      const item = params.item as {
        type?: string;
        text?: string;
        phase?: string | null;
      } | undefined;
      if (
        item &&
        ['agentMessage', 'agent_message'].includes(item.type ?? '') &&
        item.phase === 'final_answer' &&
        typeof item.text === 'string'
      ) {
        this.turns.get(threadId)?.messages.push(item.text);
      }
      return;
    }

    if (method === 'error' && threadId) {
      if (params.willRetry === true) {
        return;
      }
      const detail = params.error as { message?: string } | undefined;
      this.rejectTurn(threadId, new Error(detail?.message ?? 'Codex turn failed'));
      return;
    }

    if (method === 'turn/completed' && threadId) {
      const waiter = this.turns.get(threadId);
      if (!waiter || waiter.settled) {
        return;
      }
      const turn = params.turn as {
        status?: string;
        error?: { message?: string } | null;
        items?: Array<{ type?: string; text?: string; phase?: string | null }>;
      } | undefined;
      if (turn?.status && turn.status !== 'completed') {
        this.rejectTurn(threadId, new Error(turn.error?.message ?? 'Codex turn ' + turn.status));
        return;
      }
      const itemMessages = turn?.items
        ?.filter(
          (item) =>
            ['agentMessage', 'agent_message'].includes(item.type ?? '') &&
            item.phase === 'final_answer',
        )
        .map((item) => item.text)
        .filter((text): text is string => typeof text === 'string');
      const finalMessage = itemMessages?.at(-1) ?? waiter.messages.at(-1);
      if (finalMessage === undefined) {
        this.rejectTurn(threadId, new Error('Codex returned no final translation'));
        return;
      }
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiter.removeAbortListener?.();
      this.turns.delete(threadId);
      waiter.resolve({ content: finalMessage, usage: waiter.usage });
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    const method = message.method ?? '';
    let result: unknown;
    if (method.includes('requestApproval')) {
      result = method === 'item/permissions/requestApproval'
        ? { permissions: [], scope: 'turn' }
        : { decision: 'decline' };
    } else if (method === 'mcpServer/elicitation/request') {
      result = { action: 'decline', content: null };
    } else if (method === 'item/tool/requestUserInput') {
      result = { answers: {} };
    } else {
      this.send({
        id: message.id,
        error: { code: -32601, message: 'Client does not support ' + method },
      });
      return;
    }
    this.send({ id: message.id, result });
  }

  private waitForTurn(threadId: string, options: TextRunOptions): Promise<TextRunResult> {
    return new Promise<TextRunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.request('turn/interrupt', { threadId }, 5_000).catch(() => undefined);
        this.rejectTurn(threadId, new Error('Codex generation timed out'));
      }, this.config.requestTimeoutMs);
      const abort = () => {
        void this.request('turn/interrupt', { threadId }, 5_000).catch(() => undefined);
        this.rejectTurn(threadId, new Error('Codex generation was cancelled'));
      };
      const removeAbortListener = options.signal
        ? () => options.signal?.removeEventListener('abort', abort)
        : undefined;
      this.turns.set(threadId, {
        messages: [],
        streamingItemIds: new Set<string>(),
        onDelta: options.onDelta,
        removeAbortListener,
        usage: null,
        resolve,
        reject,
        timer,
        settled: false,
      });
      if (options.signal?.aborted) {
        queueMicrotask(abort);
      } else {
        options.signal?.addEventListener('abort', abort, { once: true });
      }
    });
  }

  private rejectTurn(threadId: string, error: Error): void {
    const waiter = this.turns.get(threadId);
    if (!waiter || waiter.settled) {
      return;
    }
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiter.removeAbortListener?.();
    this.turns.delete(threadId);
    waiter.reject(error);
  }

  private handleExit(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.stopping || this.child !== child) {
      return;
    }
    this.child = null;
    this.lineReader?.close();
    this.lineReader = null;
    this.status = {
      ready: false,
      authMode: null,
      planType: null,
      error: error.message,
    };
    this.failAll(error);
    this.startPromise = null;
    this.clearModelCatalog();
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const [threadId] of this.turns) {
      this.rejectTurn(threadId, error);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeGpt56Models(values: readonly unknown[]): CodexModel[] {
  const unique = new Map<string, CodexModel>();
  for (const value of values) {
    const model = parseModel(value);
    if (
      model &&
      GPT_56_MODEL_PATTERN.test(model.model) &&
      model.hidden !== true &&
      !unique.has(model.id.toLowerCase())
    ) {
      unique.set(model.id.toLowerCase(), model);
    }
  }
  return [...unique.values()].map(cloneModel);
}

export async function collectGpt56ModelCatalog(
  loadPage: (cursor?: string) => Promise<{ data?: unknown; nextCursor?: unknown }>,
): Promise<CodexModel[]> {
  const models = new Map<string, CodexModel>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const page = await loadPage(cursor);
    if (!Array.isArray(page.data)) {
      throw new Error('Codex returned an invalid model catalog');
    }
    for (const model of normalizeGpt56Models(page.data)) {
      if (!models.has(model.id.toLowerCase())) {
        models.set(model.id.toLowerCase(), model);
      }
    }

    const nextCursor =
      typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return [...models.values()].map(cloneModel);
}

export function resolveGpt56Model(
  models: CodexModel[],
  requested?: string,
  configured?: string,
): CodexModel {
  if (models.length === 0) {
    throw new ModelUnavailableError();
  }

  const supportedIds = models.map((model) => model.id);
  const requestedValue = requested?.trim();
  if (requested !== undefined && !requestedValue) {
    throw new UnsupportedModelError(requested, supportedIds);
  }
  const useConfiguredDefault =
    requestedValue === undefined || DEFAULT_MODEL_ALIASES.has(requestedValue.toLowerCase());
  const configuredValue = useConfiguredDefault ? configured?.trim() || undefined : undefined;
  const configuredIsAlias = configuredValue
    ? DEFAULT_MODEL_ALIASES.has(configuredValue.toLowerCase())
    : false;
  const candidate = useConfiguredDefault && !configuredIsAlias ? configuredValue : requestedValue;

  if (candidate && !DEFAULT_MODEL_ALIASES.has(candidate.toLowerCase())) {
    const match = findModel(models, candidate);
    if (match) {
      return match;
    }
    if (useConfiguredDefault && configuredValue) {
      throw new ModelUnavailableError(
        'Configured GPT-5.6 model "' + configuredValue + '" is not available for this account',
      );
    }
    throw new UnsupportedModelError(candidate, supportedIds);
  }

  const fallback = models.find((model) => model.isDefault) ?? models[0];
  if (!fallback) {
    throw new ModelUnavailableError();
  }
  return cloneModel(fallback);
}

export function assertReasoningEffortSupported(model: CodexModel, effort: string): void {
  if (model.supportedReasoningEfforts.length === 0) {
    return;
  }
  const supported = model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
  if (!supported.some((value) => value.toLowerCase() === effort.toLowerCase())) {
    throw new ModelUnavailableError(
      'Reasoning effort "' +
        effort +
        '" is not supported by ' +
        model.id +
        '. Supported values: ' +
        supported.join(', '),
    );
  }
}

function resolveRunReasoningEffort(model: CodexModel, effort: string): string {
  try {
    assertReasoningEffortSupported(model, effort);
    return effort;
  } catch (error) {
    const normalized = effort.toLowerCase();
    const fallbackNames = normalized === 'none'
      ? ['minimal', 'low']
      : normalized === 'minimal'
        ? ['low']
        : [];
    const supported = new Set(
      model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort.toLowerCase()),
    );
    const fallback = fallbackNames.find((candidate) => supported.has(candidate));
    if (fallback) {
      return fallback;
    }
    throw error;
  }
}

function parseModel(value: unknown): CodexModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const idValue = nonEmptyString(raw.id);
  const modelValue = nonEmptyString(raw.model);
  const id = idValue ?? modelValue;
  const model = modelValue ?? idValue;
  if (!id || !model) {
    return null;
  }

  const supportedReasoningEfforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
        .map(parseReasoningEffort)
        .filter((effort): effort is CodexReasoningEffort => effort !== null)
    : [];
  const inputModalities = Array.isArray(raw.inputModalities)
    ? raw.inputModalities.filter((entry): entry is string => typeof entry === 'string')
    : undefined;

  return {
    id,
    model,
    displayName: nonEmptyString(raw.displayName) ?? id,
    description: nonEmptyString(raw.description),
    hidden: raw.hidden === true,
    isDefault: raw.isDefault === true,
    defaultReasoningEffort: nonEmptyString(raw.defaultReasoningEffort),
    supportedReasoningEfforts,
    inputModalities: inputModalities?.length ? inputModalities : undefined,
  };
}

function parseReasoningEffort(value: unknown): CodexReasoningEffort | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const reasoningEffort = nonEmptyString(raw.reasoningEffort);
  if (!reasoningEffort) {
    return null;
  }
  return {
    reasoningEffort,
    description: nonEmptyString(raw.description),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isTokenUsage(value: Partial<TokenUsage>): value is TokenUsage {
  return [
    value.totalTokens,
    value.inputTokens,
    value.cachedInputTokens,
    value.outputTokens,
    value.reasoningOutputTokens,
  ].every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0);
}

function findModel(models: CodexModel[], requested: string): CodexModel | undefined {
  const normalized = requested.toLowerCase();
  const idMatch = models.find((model) => model.id.toLowerCase() === normalized);
  if (idMatch) {
    return cloneModel(idMatch);
  }
  const runtimeMatches = models.filter((model) => model.model.toLowerCase() === normalized);
  return runtimeMatches.length === 1 && runtimeMatches[0]
    ? cloneModel(runtimeMatches[0])
    : undefined;
}

function cloneModel(model: CodexModel): CodexModel {
  return {
    ...model,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({ ...effort })),
    inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
  };
}
