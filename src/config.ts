import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDirectory: string;
  runtimeDirectory: string;
  cacheFile: string;
  tokenFile: string;
  noAuth: boolean;
  model?: string;
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  requestTimeoutMs: number;
  bodyLimitBytes: number;
  maxTextChars: number;
  maxBatchItems: number;
  batchWindowMs: number;
  cacheMaxEntries: number;
  cachePersistent: boolean;
  defaultSource: string;
  defaultTarget: string;
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return value;
}

function booleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function effortEnv(): AppConfig['reasoningEffort'] {
  const value = (process.env.CODEX_TRANSLATOR_REASONING_EFFORT ?? 'low').toLowerCase();
  if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) {
    throw new Error('CODEX_TRANSLATOR_REASONING_EFFORT is invalid');
  }
  return value as AppConfig['reasoningEffort'];
}

function assertLoopback(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (!['127.0.0.1', '::1', 'localhost'].includes(normalized)) {
    throw new Error('For safety, CODEX_TRANSLATOR_HOST must be a loopback address');
  }
}

export function loadConfig(): AppConfig {
  const root = path.resolve(process.env.CODEX_TRANSLATOR_HOME ?? process.cwd());
  const dataDirectory = path.resolve(process.env.CODEX_TRANSLATOR_DATA_DIR ?? path.join(root, 'data'));
  const host = process.env.CODEX_TRANSLATOR_HOST ?? '127.0.0.1';
  assertLoopback(host);

  return {
    host,
    port: integerEnv('CODEX_TRANSLATOR_PORT', 8765, 1, 65535),
    dataDirectory,
    runtimeDirectory: path.join(dataDirectory, 'runtime'),
    cacheFile: path.join(dataDirectory, 'translations.jsonl'),
    tokenFile: path.join(dataDirectory, 'token.txt'),
    noAuth: booleanEnv('CODEX_TRANSLATOR_NO_AUTH'),
    model: process.env.CODEX_TRANSLATOR_MODEL?.trim() || undefined,
    reasoningEffort: effortEnv(),
    requestTimeoutMs: integerEnv('CODEX_TRANSLATOR_TIMEOUT_MS', 90_000, 5_000, 600_000),
    bodyLimitBytes: integerEnv('CODEX_TRANSLATOR_BODY_LIMIT', 1_048_576, 1_024, 10_485_760),
    maxTextChars: integerEnv('CODEX_TRANSLATOR_MAX_TEXT_CHARS', 12_000, 1, 100_000),
    maxBatchItems: integerEnv('CODEX_TRANSLATOR_MAX_BATCH_ITEMS', 16, 1, 64),
    batchWindowMs: integerEnv('CODEX_TRANSLATOR_BATCH_WINDOW_MS', 80, 0, 2_000),
    cacheMaxEntries: integerEnv('CODEX_TRANSLATOR_CACHE_MAX_ENTRIES', 20_000, 100, 1_000_000),
    cachePersistent: booleanEnv('CODEX_TRANSLATOR_PERSIST_CACHE', true),
    defaultSource: process.env.CODEX_TRANSLATOR_SOURCE ?? 'auto',
    defaultTarget: process.env.CODEX_TRANSLATOR_TARGET ?? 'ko',
  };
}
