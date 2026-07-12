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
import {
  BRIDGE_BASE_INSTRUCTIONS,
  BRIDGE_DEVELOPER_INSTRUCTIONS,
  TRANSLATOR_BASE_INSTRUCTIONS,
  TRANSLATOR_DEVELOPER_INSTRUCTIONS,
} from '../src/prompt.js';
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

test('passes request instructions and reasoning to the correct App Server fields', async () => {
  const client = new CodexAppServerClient(
    clientConfig({ reasoningEffort: 'none' }),
    () => undefined,
  );
  const selected = normalizeGpt56Models(RAW_MODELS)[0];
  assert.ok(selected);
  const model = selected as CodexModel;
  client.resolveModel = async () => model;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const sequence: string[] = [];
  const harness = client as unknown as {
    request(
      method: string,
      params: Record<string, unknown>,
      timeoutMs: number,
    ): Promise<unknown>;
    waitForTurn(): Promise<{ content: string; usage: null }>;
  };
  harness.request = async (method, params) => {
    sequence.push(method);
    calls.push({ method, params });
    return method === 'thread/start' ? { thread: { id: 'thread-test' } } : {};
  };
  harness.waitForTurn = async () => {
    sequence.push('waitForTurn');
    return { content: 'OK', usage: null };
  };

  let ready = false;
  const historyItems = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Earlier question' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Earlier answer' }],
    },
  ];
  const result = await client.runText(
    'Hello',
    { id: model.id, model: model.model },
    {
      developerInstructions: 'Preserve the requested format.',
      historyItems,
      reasoningEffort: 'high',
      systemInstructions: 'Translate only into Korean.',
      onReady: () => {
        sequence.push('onReady');
        ready = true;
      },
    },
  );
  assert.deepEqual(result, { content: 'OK', usage: null });
  assert.equal(ready, true);
  assert.deepEqual(sequence.slice(0, 6), [
    'thread/start',
    'thread/inject_items',
    'onReady',
    'waitForTurn',
    'turn/start',
    'thread/unsubscribe',
  ]);
  const threadStart = calls.find((call) => call.method === 'thread/start');
  const baseInstructions = threadStart?.params.baseInstructions;
  const developerInstructions = threadStart?.params.developerInstructions;
  assert.equal(typeof baseInstructions, 'string');
  assert.equal(typeof developerInstructions, 'string');
  assert.match(baseInstructions as string, /Translate only into Korean\./);
  assert.match(developerInstructions as string, /Preserve the requested format\./);
  assert.ok((baseInstructions as string).endsWith(BRIDGE_BASE_INSTRUCTIONS));
  assert.ok((developerInstructions as string).endsWith(BRIDGE_DEVELOPER_INSTRUCTIONS));
  assert.ok(
    (baseInstructions as string).indexOf('Translate only into Korean.') <
      (baseInstructions as string).indexOf(BRIDGE_BASE_INSTRUCTIONS),
  );
  assert.ok(
    (developerInstructions as string).indexOf('Preserve the requested format.') <
      (developerInstructions as string).indexOf(BRIDGE_DEVELOPER_INSTRUCTIONS),
  );
  const injectItems = calls.find((call) => call.method === 'thread/inject_items');
  assert.deepEqual(injectItems?.params.items, historyItems);
  assert.deepEqual(
    (injectItems?.params.items as Array<{ role: string }>).map((item) => item.role),
    ['user', 'assistant'],
  );
  const turnStart = calls.find((call) => call.method === 'turn/start');
  assert.equal(turnStart?.params.effort, 'high');
  assert.equal(
    threadStart?.params.effort,
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
  await client.runStructured(
    'Translate this',
    { type: 'object' },
    { id: model.id, model: model.model },
  );
  const structuredThreadStart = calls.find((call) => call.method === 'thread/start');
  assert.equal(structuredThreadStart?.params.baseInstructions, TRANSLATOR_BASE_INSTRUCTIONS);
  assert.equal(
    structuredThreadStart?.params.developerInstructions,
    TRANSLATOR_DEVELOPER_INSTRUCTIONS,
  );
  assert.equal(calls.some((call) => call.method === 'thread/inject_items'), false);

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

test('does not mark a request ready when sanitized history injection fails', async () => {
  const client = new CodexAppServerClient(clientConfig(), () => undefined);
  const selected = normalizeGpt56Models(RAW_MODELS)[0];
  assert.ok(selected);
  const model = selected as CodexModel;
  client.resolveModel = async () => model;
  const calls: string[] = [];
  const harness = client as unknown as {
    request(
      method: string,
      params: Record<string, unknown>,
      timeoutMs: number,
    ): Promise<unknown>;
    waitForTurn(): Promise<{ content: string; usage: null }>;
  };
  harness.request = async (method) => {
    calls.push(method);
    if (method === 'thread/start') {
      return { thread: { id: 'thread-inject-failure' } };
    }
    if (method === 'thread/inject_items') {
      throw new Error('synthetic history injection failure');
    }
    return {};
  };
  harness.waitForTurn = async () => {
    assert.fail('waitForTurn must not start before history injection succeeds');
  };

  let ready = false;
  await assert.rejects(
    client.runText(
      'Hello',
      { id: model.id, model: model.model },
      {
        historyItems: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Earlier question' }],
          },
        ],
        onReady: () => { ready = true; },
      },
    ),
    /synthetic history injection failure/,
  );
  assert.equal(ready, false);
  assert.deepEqual(calls, ['thread/start', 'thread/inject_items', 'thread/unsubscribe']);
  assert.equal(calls.includes('turn/start'), false);
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
