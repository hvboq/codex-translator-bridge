import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UnsupportedModelError, type StructuredRunner } from '../src/app-server-client.js';
import { TranslationCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { InputError, TranslationService } from '../src/translation-service.js';
import type { ChatMessage, CodexModel, CodexModelSelection } from '../src/types.js';

const TEST_MODELS: CodexModel[] = [
  {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    inputModalities: ['text'],
  },
  {
    id: 'gpt-5.6-terra',
    model: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    isDefault: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    inputModalities: ['text'],
  },
  {
    id: 'gpt-5.6-luna',
    model: 'gpt-5.6-runtime-luna',
    displayName: 'GPT-5.6-Luna',
    isDefault: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    inputModalities: ['text'],
  },
];

class FakeRunner implements StructuredRunner {
  readonly calls: Array<{ prompt: string; schema: object; model: string }> = [];

  async listModels(): Promise<CodexModel[]> {
    return TEST_MODELS.map((model) => ({ ...model }));
  }

  async resolveModel(requested?: string): Promise<CodexModel> {
    const value = requested && requested !== 'codex-translator' ? requested : 'gpt-5.6-sol';
    const model = TEST_MODELS.find(
      (entry) => entry.id === value || entry.model === value,
    );
    if (!model) {
      throw new UnsupportedModelError(value, TEST_MODELS.map((entry) => entry.id));
    }
    return { ...model };
  }

  async runStructured(
    prompt: string,
    schema: object,
    selection: CodexModelSelection,
  ): Promise<string> {
    this.calls.push({ prompt, schema, model: selection.model });
    if (prompt.includes('INPUT_JSON:')) {
      const values = JSON.parse(prompt.split('INPUT_JSON:\n')[1] ?? '[]') as Array<{
        source_text: string;
      }>;
      return JSON.stringify({ translations: values.map((value) => '번역:' + value.source_text) });
    }
    const groups = JSON.parse(prompt.split('MESSAGES_GROUPS_JSON:\n')[1] ?? '[]') as Array<{
      messages: ChatMessage[];
    }>;
    return JSON.stringify({
      contents: groups.map((group) => {
        const last = group.messages.at(-1);
        return '채팅:' + String(last?.content ?? '');
      }),
    });
  }
}

test('micro-batches misses and persists cache hits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-translator-test-'));
  const config = testConfig(directory);
  const cache = new TranslationCache(config.cacheFile, 100);
  await cache.initialize();
  const runner = new FakeRunner();
  const service = new TranslationService(config, runner, cache);

  const [first, second] = await Promise.all([
    service.translate({ text: 'こんにちは', source: 'ja', target: 'ko' }),
    service.translate({ text: 'ありがとう', source: 'ja', target: 'ko' }),
  ]);

  assert.equal(first.translations[0], '번역:こんにちは');
  assert.equal(second.translations[0], '번역:ありがとう');
  assert.equal(runner.calls.length, 1);

  const repeated = await service.translate({ text: 'こんにちは', source: 'ja', target: 'ko' });
  assert.deepEqual(repeated.cached, [true]);
  assert.equal(runner.calls.length, 1);

  const reloaded = new TranslationCache(config.cacheFile, 100);
  await reloaded.initialize();
  const afterRestartRunner = new FakeRunner();
  const afterRestart = new TranslationService(config, afterRestartRunner, reloaded);
  const persisted = await afterRestart.translate({ text: 'ありがとう', source: 'ja', target: 'ko' });
  assert.deepEqual(persisted.cached, [true]);
  assert.equal(persisted.model, 'gpt-5.6-sol');
  assert.equal(afterRestartRunner.calls.length, 0);
});

test('separates cache, in-flight work, and micro-batches by resolved model', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-translator-model-test-'));
  const config = testConfig(directory);
  const cache = new TranslationCache(config.cacheFile, 100);
  await cache.initialize();
  const runner = new FakeRunner();
  const service = new TranslationService(config, runner, cache);

  const [solAlpha, solBeta, terraAlpha] = await Promise.all([
    service.translate({ text: 'Alpha', model: 'gpt-5.6-sol' }),
    service.translate({ text: 'Beta', model: 'gpt-5.6-sol' }),
    service.translate({ text: 'Alpha', model: 'gpt-5.6-terra' }),
  ]);

  assert.equal(solAlpha.model, 'gpt-5.6-sol');
  assert.equal(solBeta.model, 'gpt-5.6-sol');
  assert.equal(terraAlpha.model, 'gpt-5.6-terra');
  assert.deepEqual(runner.calls.map((call) => call.model), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
  ]);
  assert.match(runner.calls[0]?.prompt ?? '', /Alpha/);
  assert.match(runner.calls[0]?.prompt ?? '', /Beta/);

  const [cachedSol, cachedTerra] = await Promise.all([
    service.translate({ text: 'Alpha', model: 'gpt-5.6-sol' }),
    service.translate({ text: 'Alpha', model: 'gpt-5.6-terra' }),
  ]);
  assert.deepEqual(cachedSol.cached, [true]);
  assert.deepEqual(cachedTerra.cached, [true]);
  assert.equal(runner.calls.length, 2);
});

test('uses a canonical cache key for OpenAI-compatible messages', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-translator-chat-test-'));
  const config = testConfig(directory);
  const cache = new TranslationCache(config.cacheFile, 100);
  await cache.initialize();
  const runner = new FakeRunner();
  const service = new TranslationService(config, runner, cache);

  const normal: ChatMessage[] = [
    { role: 'system', content: 'Translate to Korean' },
    { role: 'user', content: 'Hello' },
  ];
  const reordered = [
    { content: 'Translate to Korean', role: 'system' },
    { content: 'Hello', role: 'user' },
  ] as ChatMessage[];

  assert.deepEqual(await service.translateChat(normal), {
    content: '채팅:Hello',
    model: 'gpt-5.6-sol',
  });
  assert.deepEqual(await service.translateChat(reordered), {
    content: '채팅:Hello',
    model: 'gpt-5.6-sol',
  });
  assert.equal(runner.calls.length, 1);
});

test('separates chat cache, in-flight work, and batches by resolved model', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-translator-chat-model-test-'));
  const config = testConfig(directory);
  const cache = new TranslationCache(config.cacheFile, 100);
  await cache.initialize();
  const runner = new FakeRunner();
  const service = new TranslationService(config, runner, cache);
  const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];

  const [firstSol, duplicateSol, luna] = await Promise.all([
    service.translateChat(messages, 'gpt-5.6-sol'),
    service.translateChat(messages, 'gpt-5.6-sol'),
    service.translateChat(messages, 'gpt-5.6-luna'),
  ]);

  assert.equal(firstSol.model, 'gpt-5.6-sol');
  assert.deepEqual(duplicateSol, firstSol);
  assert.equal(luna.model, 'gpt-5.6-luna');
  assert.deepEqual(runner.calls.map((call) => call.model), [
    'gpt-5.6-sol',
    'gpt-5.6-runtime-luna',
  ]);

  await service.translateChat(messages, 'gpt-5.6-sol');
  await service.translateChat(messages, 'gpt-5.6-luna');
  assert.equal(runner.calls.length, 2);
});

test('protects and restores game formatting tokens', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-translator-token-test-'));
  const config = testConfig(directory);
  const cache = new TranslationCache(config.cacheFile, 100);
  await cache.initialize();
  const runner = new FakeRunner();
  const service = new TranslationService(config, runner, cache);

  const source = '<b>{name}</b> HP: %03d\\n[wait]';
  const result = await service.translate({ text: source, source: 'en', target: 'ko' });
  assert.equal(result.translations[0], '번역:' + source);
  assert.match(runner.calls[0]?.prompt ?? '', /__CXPH_/);

  const chat = await service.translateChat([
    { role: 'system', content: 'Translate to Korean' },
    { role: 'user', content: 'Hello {name}<br>' },
  ]);
  assert.equal(chat.content, '채팅:Hello {name}<br>');
  assert.equal(chat.model, 'gpt-5.6-sol');
});

test('rejects oversized and malformed translation inputs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-translator-limit-test-'));
  const config = { ...testConfig(directory), maxTextChars: 3 };
  const cache = new TranslationCache(config.cacheFile, 100);
  await cache.initialize();
  const service = new TranslationService(config, new FakeRunner(), cache);

  await assert.rejects(
    service.translate({ text: '1234' }),
    (error: unknown) => error instanceof InputError,
  );
  await assert.rejects(
    service.translate({ text: ['valid', 1] as unknown as string[] }),
    (error: unknown) => error instanceof InputError,
  );
  await assert.rejects(
    service.translate({ text: 'ok', source: 1 as unknown as string }),
    (error: unknown) => error instanceof InputError,
  );
  await assert.rejects(
    service.translate({ text: 'ok', style: {} as unknown as string }),
    (error: unknown) => error instanceof InputError,
  );
  await assert.rejects(
    service.translate({ text: 'ok', model: 1 as unknown as string }),
    (error: unknown) => error instanceof InputError,
  );
  await assert.rejects(
    service.translate({ text: 'ok', model: '' }),
    (error: unknown) => error instanceof InputError,
  );
  await assert.rejects(
    service.translate({ text: 'ok', model: 'gpt-5.5-codex' }),
    (error: unknown) => error instanceof UnsupportedModelError,
  );
  await assert.rejects(
    service.translate(null as unknown as Parameters<TranslationService['translate']>[0]),
    (error: unknown) => error instanceof InputError,
  );
  await assert.rejects(
    service.translateChat([{ role: 1 as unknown as string, content: 'Hello' }]),
    (error: unknown) => error instanceof InputError,
  );
});

test('recovers the persistent cache queue after a write failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-translator-cache-test-'));
  const cacheDirectory = path.join(directory, 'cache');
  const cacheFile = path.join(cacheDirectory, 'translations.jsonl');
  const cache = new TranslationCache(cacheFile, 100);
  await cache.initialize();

  await rm(cacheDirectory, { recursive: true, force: true });
  await writeFile(cacheDirectory, 'blocks directory creation', 'utf8');
  await assert.rejects(cache.set('first', 'one'));

  await rm(cacheDirectory, { force: true });
  await mkdir(cacheDirectory, { recursive: true });
  await cache.set('second', 'two');
  assert.match(await readFile(cacheFile, 'utf8'), /"key":"second"/);
});

function testConfig(directory: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    runtimeDirectory: path.join(directory, 'runtime'),
    cacheFile: path.join(directory, 'cache.jsonl'),
    tokenFile: path.join(directory, 'token.txt'),
    noAuth: false,
    reasoningEffort: 'low',
    requestTimeoutMs: 10_000,
    bodyLimitBytes: 100_000,
    maxTextChars: 10_000,
    maxBatchItems: 8,
    batchWindowMs: 10,
    cacheMaxEntries: 100,
    cachePersistent: true,
    defaultSource: 'auto',
    defaultTarget: 'ko',
  };
}
