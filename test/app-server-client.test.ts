import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReasoningEffortSupported,
  CodexAppServerClient,
  collectGpt56ModelCatalog,
  ModelUnavailableError,
  normalizeGpt56Models,
  resolveGpt56Model,
  UnsupportedModelError,
} from '../src/app-server-client.js';
import type { AppConfig } from '../src/config.js';
import type { CodexModel } from '../src/types.js';

const RAW_MODELS = [
  {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Default model',
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'high', description: 'Careful' },
    ],
    inputModalities: ['text', 'image'],
  },
  {
    id: 'gpt-5.6-terra',
    model: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    isDefault: false,
    supportedReasoningEfforts: [],
  },
  {
    id: 'gpt-5.6-luna',
    model: 'gpt-5.6-luna',
    displayName: 'GPT-5.6-Luna',
    isDefault: false,
    supportedReasoningEfforts: [],
  },
  {
    id: 'gpt-5.5-codex',
    model: 'gpt-5.5-codex',
    displayName: 'GPT-5.5-Codex',
    isDefault: false,
  },
  {
    id: 'gpt-5.6-hidden',
    model: 'gpt-5.6-hidden',
    displayName: 'Hidden GPT-5.6',
    hidden: true,
    isDefault: false,
  },
  { id: '', model: '' },
  null,
];

test('normalizes the App Server catalog to unique GPT-5.6 models', () => {
  const models = normalizeGpt56Models([...RAW_MODELS, RAW_MODELS[0]]);

  assert.deepEqual(models.map((model) => model.id), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ]);
  assert.equal(models[0]?.model, 'gpt-5.6-sol');
  assert.equal(models[0]?.displayName, 'GPT-5.6-Sol');
  assert.deepEqual(models[0]?.supportedReasoningEfforts, [
    { reasoningEffort: 'low', description: 'Fast' },
    { reasoningEffort: 'high', description: 'Careful' },
  ]);
  assert.deepEqual(models[0]?.inputModalities, ['text', 'image']);
});

test('collects paginated model pages, deduplicates entries, and stops cursor loops', async () => {
  const cursors: Array<string | undefined> = [];
  const models = await collectGpt56ModelCatalog(async (cursor) => {
    cursors.push(cursor);
    if (cursor === undefined) {
      return { data: [RAW_MODELS[0], RAW_MODELS[3]], nextCursor: 'page-2' };
    }
    if (cursor === 'page-2') {
      return { data: [RAW_MODELS[1], RAW_MODELS[0]], nextCursor: 'page-3' };
    }
    return { data: [RAW_MODELS[2]], nextCursor: 'page-3' };
  });

  assert.deepEqual(cursors, [undefined, 'page-2', 'page-3']);
  assert.deepEqual(models.map((model) => model.id), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ]);
  await assert.rejects(
    collectGpt56ModelCatalog(async () => ({ data: null })),
    /invalid model catalog/,
  );
});

test('resolves explicit models, the compatibility alias, and configured defaults', () => {
  const models = normalizeGpt56Models(RAW_MODELS);

  assert.equal(resolveGpt56Model(models).id, 'gpt-5.6-sol');
  assert.equal(resolveGpt56Model(models, 'gpt-5.6-luna').id, 'gpt-5.6-luna');
  assert.equal(resolveGpt56Model(models, 'GPT-5.6-TERRA').id, 'gpt-5.6-terra');
  assert.equal(resolveGpt56Model(models, undefined, 'gpt-5.6-terra').id, 'gpt-5.6-terra');
  assert.equal(
    resolveGpt56Model(models, 'codex-bridge', 'gpt-5.6-terra').id,
    'gpt-5.6-terra',
  );
  assert.equal(
    resolveGpt56Model(models, 'codex-translator', 'gpt-5.6-luna').id,
    'gpt-5.6-luna',
  );
  assert.equal(
    resolveGpt56Model(models, 'codex-translator', 'codex-translator').id,
    'gpt-5.6-sol',
  );
  assert.equal(
    resolveGpt56Model(models.map((model) => ({ ...model, isDefault: false }))).id,
    'gpt-5.6-sol',
  );
});

test('prefers a public ID over a colliding runtime model name', () => {
  const models = normalizeGpt56Models([
    {
      id: 'gpt-5.6-public-a',
      model: 'gpt-5.6-runtime-b',
      displayName: 'Public A',
      isDefault: true,
    },
    {
      id: 'gpt-5.6-runtime-b',
      model: 'gpt-5.6-runtime-c',
      displayName: 'Public B',
      isDefault: false,
    },
  ]);

  assert.equal(resolveGpt56Model(models, 'gpt-5.6-public-a').model, 'gpt-5.6-runtime-b');
  assert.equal(resolveGpt56Model(models, 'gpt-5.6-runtime-b').id, 'gpt-5.6-runtime-b');
  assert.equal(resolveGpt56Model(models, 'gpt-5.6-runtime-b').model, 'gpt-5.6-runtime-c');
});

test('rejects unknown requests, unavailable configured models, and empty catalogs', () => {
  const models = normalizeGpt56Models(RAW_MODELS);

  assert.throws(
    () => resolveGpt56Model(models, 'gpt-5.5-codex'),
    UnsupportedModelError,
  );
  assert.throws(
    () => resolveGpt56Model(models, 'gpt-5.6-unknown'),
    UnsupportedModelError,
  );
  assert.throws(() => resolveGpt56Model(models, ''), UnsupportedModelError);
  assert.throws(
    () => resolveGpt56Model(models, undefined, 'gpt-5.6-unknown'),
    ModelUnavailableError,
  );
  assert.throws(() => resolveGpt56Model([]), ModelUnavailableError);
});

test('checks configured reasoning effort against the selected model catalog entry', () => {
  const model = normalizeGpt56Models(RAW_MODELS)[0];
  assert.ok(model);
  assert.doesNotThrow(() => assertReasoningEffortSupported(model, 'low'));
  assert.throws(
    () => assertReasoningEffortSupported(model, 'minimal'),
    ModelUnavailableError,
  );
});

test('passes request reasoning effort to turn/start and revalidates the live catalog', async () => {
  const client = new CodexAppServerClient(
    clientConfig({ reasoningEffort: 'none' }),
    () => undefined,
  );
  const selected = normalizeGpt56Models(RAW_MODELS)[0];
  assert.ok(selected);
  const model = selected as CodexModel;
  client.resolveModel = async () => model;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const harness = client as unknown as {
    request(
      method: string,
      params: Record<string, unknown>,
      timeoutMs: number,
    ): Promise<unknown>;
    waitForTurn(): Promise<{ content: string; usage: null }>;
  };
  harness.request = async (method, params) => {
    calls.push({ method, params });
    return method === 'thread/start' ? { thread: { id: 'thread-test' } } : {};
  };
  harness.waitForTurn = async () => ({ content: 'OK', usage: null });

  let ready = false;
  const result = await client.runText(
    'Hello',
    { id: model.id, model: model.model },
    { reasoningEffort: 'high', onReady: () => { ready = true; } },
  );
  assert.deepEqual(result, { content: 'OK', usage: null });
  assert.equal(ready, true);
  const turnStart = calls.find((call) => call.method === 'turn/start');
  assert.equal(turnStart?.params.effort, 'high');
  assert.equal(
    calls.find((call) => call.method === 'thread/start')?.params.effort,
    undefined,
  );

  calls.length = 0;
  await client.runText(
    'Hello',
    { id: model.id, model: model.model },
    {},
  );
  assert.equal(
    calls.find((call) => call.method === 'turn/start')?.params.effort,
    'low',
  );

  calls.length = 0;
  ready = false;
  await assert.rejects(
    client.runText(
      'Hello',
      { id: model.id, model: model.model },
      { reasoningEffort: 'none', onReady: () => { ready = true; } },
    ),
    ModelUnavailableError,
  );
  assert.equal(calls.length, 0);
  assert.equal(ready, false);

  calls.length = 0;
  await assert.rejects(
    client.runText(
      'Hello',
      { id: model.id, model: model.model },
      { reasoningEffort: 'ultra', onReady: () => { ready = true; } },
    ),
    ModelUnavailableError,
  );
  assert.equal(calls.length, 0);
  assert.equal(ready, false);
});

function clientConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDirectory: process.cwd(),
    runtimeDirectory: process.cwd(),
    cacheFile: 'cache.jsonl',
    tokenFile: 'token.txt',
    noAuth: false,
    reasoningEffort: 'low',
    requestTimeoutMs: 10_000,
    bodyLimitBytes: 100_000,
    maxTextChars: 10_000,
    maxBatchItems: 8,
    maxConcurrentGenerations: 2,
    batchWindowMs: 1,
    cacheMaxEntries: 100,
    cachePersistent: false,
    defaultSource: 'auto',
    defaultTarget: 'ko',
    ...overrides,
  };
}
