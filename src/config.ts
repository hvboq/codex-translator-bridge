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
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  requestTimeoutMs: number;
  bodyLimitBytes: number;
  maxTextChars: number;
  maxBatchItems: number;
  maxConcurrentGenerations: number;
  batchWindowMs: number;
  cacheMaxEntries: number;
  cachePersistent: boolean;
  defaultSource: string;
  defaultTarget: string;
}

function envValue(name: string, legacyName: string): string | undefined {
  return process.env[name] ?? process.env[legacyName];
}

function integerEnv(
  name: string,
  legacyName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = envValue(name, legacyName);
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return value;
}

function booleanEnv(name: string, legacyName: string, fallback = false): boolean {
  const raw = envValue(name, legacyName);
  if (raw === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function effortEnv(): AppConfig['reasoningEffort'] {
  const value = (
    envValue('CODEX_BRIDGE_REASONING_EFFORT', 'CODEX_TRANSLATOR_REASONING_EFFORT') ?? 'low'
  ).toLowerCase();
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) {
    throw new Error('CODEX_BRIDGE_REASONING_EFFORT is invalid');
  }
  return value as AppConfig['reasoningEffort'];
}

function assertLoopback(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (!['127.0.0.1', '::1', 'localhost'].includes(normalized)) {
    throw new Error('For safety, CODEX_BRIDGE_HOST must be a loopback address');
  }
}

export function loadConfig(): AppConfig {
  const root = path.resolve(
    envValue('CODEX_BRIDGE_HOME', 'CODEX_TRANSLATOR_HOME') ?? process.cwd(),
  );
  const dataDirectory = path.resolve(
    envValue('CODEX_BRIDGE_DATA_DIR', 'CODEX_TRANSLATOR_DATA_DIR') ?? path.join(root, 'data'),
  );
  const host = envValue('CODEX_BRIDGE_HOST', 'CODEX_TRANSLATOR_HOST') ?? '127.0.0.1';
  assertLoopback(host);

  return {
    host,
    port: integerEnv('CODEX_BRIDGE_PORT', 'CODEX_TRANSLATOR_PORT', 8765, 1, 65535),
    dataDirectory,
    runtimeDirectory: path.join(dataDirectory, 'runtime'),
    cacheFile: path.join(dataDirectory, 'translations.jsonl'),
    tokenFile: path.join(dataDirectory, 'token.txt'),
    noAuth: booleanEnv('CODEX_BRIDGE_NO_AUTH', 'CODEX_TRANSLATOR_NO_AUTH'),
    model: envValue('CODEX_BRIDGE_MODEL', 'CODEX_TRANSLATOR_MODEL')?.trim() || undefined,
    reasoningEffort: effortEnv(),
    requestTimeoutMs: integerEnv(
      'CODEX_BRIDGE_TIMEOUT_MS',
      'CODEX_TRANSLATOR_TIMEOUT_MS',
      90_000,
      5_000,
      600_000,
    ),
    bodyLimitBytes: integerEnv(
      'CODEX_BRIDGE_BODY_LIMIT',
      'CODEX_TRANSLATOR_BODY_LIMIT',
      1_048_576,
      1_024,
      10_485_760,
    ),
    maxTextChars: integerEnv(
      'CODEX_BRIDGE_MAX_TEXT_CHARS',
      'CODEX_TRANSLATOR_MAX_TEXT_CHARS',
      12_000,
      1,
      100_000,
    ),
    maxBatchItems: integerEnv(
      'CODEX_BRIDGE_MAX_BATCH_ITEMS',
      'CODEX_TRANSLATOR_MAX_BATCH_ITEMS',
      16,
      1,
      64,
    ),
    maxConcurrentGenerations: integerEnv(
      'CODEX_BRIDGE_MAX_CONCURRENCY',
      'CODEX_TRANSLATOR_MAX_CONCURRENCY',
      4,
      1,
      32,
    ),
    batchWindowMs: integerEnv(
      'CODEX_BRIDGE_BATCH_WINDOW_MS',
      'CODEX_TRANSLATOR_BATCH_WINDOW_MS',
      80,
      0,
      2_000,
    ),
    cacheMaxEntries: integerEnv(
      'CODEX_BRIDGE_CACHE_MAX_ENTRIES',
      'CODEX_TRANSLATOR_CACHE_MAX_ENTRIES',
      20_000,
      100,
      1_000_000,
    ),
    cachePersistent: booleanEnv(
      'CODEX_BRIDGE_PERSIST_CACHE',
      'CODEX_TRANSLATOR_PERSIST_CACHE',
      true,
    ),
    defaultSource: envValue('CODEX_BRIDGE_SOURCE', 'CODEX_TRANSLATOR_SOURCE') ?? 'auto',
    defaultTarget: envValue('CODEX_BRIDGE_TARGET', 'CODEX_TRANSLATOR_TARGET') ?? 'ko',
  };
}
