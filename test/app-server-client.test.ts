import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReasoningEffortSupported,
  collectGpt56ModelCatalog,
  ModelUnavailableError,
  normalizeGpt56Models,
  resolveGpt56Model,
  UnsupportedModelError,
} from '../src/app-server-client.js';

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
