import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { UnsupportedModelError, type StructuredRunner } from '../src/app-server-client.js';
import { TranslationCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { createHttpServer } from '../src/http-server.js';
import { TranslationService } from '../src/translation-service.js';
import type { CodexModel, CodexModelSelection } from '../src/types.js';

const HTTP_MODELS: CodexModel[] = [
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
  {
    id: 'gpt-5.6-runtime-luna',
    model: 'gpt-5.6-runtime-second',
    displayName: 'GPT-5.6 Runtime Collision Fixture',
    isDefault: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    inputModalities: ['text'],
  },
  {
    id: 'gpt-5.5-codex',
    model: 'gpt-5.5-codex',
    displayName: 'GPT-5.5-Codex',
    isDefault: false,
    supportedReasoningEfforts: [],
  },
];

class HttpFakeRunner implements StructuredRunner {
  readonly calls: Array<{ model: string; prompt: string }> = [];

  async listModels(): Promise<CodexModel[]> {
    return HTTP_MODELS.map((model) => ({ ...model }));
  }

  async resolveModel(requested?: string): Promise<CodexModel> {
    const value = requested && requested !== 'codex-translator' ? requested : 'gpt-5.6-sol';
    const model = HTTP_MODELS.find(
      (entry) =>
        entry.model.startsWith('gpt-5.6-') &&
        (entry.id === value || entry.model === value),
    );
    if (!model) {
      throw new UnsupportedModelError(
        value,
        HTTP_MODELS.filter((entry) => entry.model.startsWith('gpt-5.6-')).map(
          (entry) => entry.id,
        ),
      );
    }
    return { ...model };
  }

  async runStructured(
    prompt: string,
    _schema: object,
    selection: CodexModelSelection,
  ): Promise<string> {
    this.calls.push({ model: selection.model, prompt });
    if (prompt.includes('INPUT_JSON:')) {
      const values = JSON.parse(prompt.split('INPUT_JSON:\n')[1] ?? '[]') as Array<{
        source_text: string;
      }>;
      return JSON.stringify({ translations: values.map((value) => 'T:' + value.source_text) });
    }
    const groups = JSON.parse(prompt.split('MESSAGES_GROUPS_JSON:\n')[1] ?? '[]') as Array<{
      messages: Array<{ content?: unknown }>;
    }>;
    return JSON.stringify({
      contents: groups.map((group) => 'C:' + String(group.messages.at(-1)?.content ?? '')),
    });
  }
}

test('serves protected translate and OpenAI-compatible endpoints', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-translator-http-test-'));
  const config = testConfig(directory);
  const cache = new TranslationCache(config.cacheFile, 100);
  await cache.initialize();
  const runner = new HttpFakeRunner();
  const service = new TranslationService(config, runner, cache);
  const status = {
    async getStatus() {
      return { ready: true, authMode: 'chatgpt', planType: 'test' };
    },
  };
  const server = createHttpServer(config, 'local-secret', status, service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const base = 'http://127.0.0.1:' + port;

  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { auth_mode: string }).auth_mode, 'chatgpt');

  const unauthorized = await fetch(base + '/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hello' }),
  });
  assert.equal(unauthorized.status, 401);

  const unauthorizedModels = await fetch(base + '/v1/models');
  assert.equal(unauthorizedModels.status, 401);

  const models = await fetch(base + '/v1/models', {
    headers: { authorization: 'Bearer local-secret' },
  });
  assert.equal(models.status, 200);
  const modelsJson = await models.json() as {
    object: string;
    data: Array<{ id: string; owned_by: string }>;
  };
  assert.equal(modelsJson.object, 'list');
  assert.deepEqual(modelsJson.data.map((model) => model.id), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.6-runtime-luna',
  ]);
  assert.ok(modelsJson.data.every((model) => model.owned_by === 'openai'));

  const modelDetail = await fetch(base + '/v1/models/gpt-5.6-terra', {
    headers: { authorization: 'Bearer local-secret' },
  });
  assert.equal(modelDetail.status, 200);
  assert.equal((await modelDetail.json() as { id: string }).id, 'gpt-5.6-terra');

  const collidingModelDetail = await fetch(base + '/v1/models/gpt-5.6-runtime-luna', {
    headers: { authorization: 'Bearer local-secret' },
  });
  assert.equal(collidingModelDetail.status, 200);
  assert.equal(
    (await collidingModelDetail.json() as { id: string }).id,
    'gpt-5.6-runtime-luna',
  );

  const unsupportedDetail = await fetch(base + '/v1/models/gpt-5.5-codex', {
    headers: { authorization: 'Bearer local-secret' },
  });
  assert.equal(unsupportedDetail.status, 400);

  const invalid = await fetch(base + '/translate', {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text: 'Hello', source: 42 }),
  });
  assert.equal(invalid.status, 400);

  const translated = await fetch(base + '/translate', {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text: 'Hello',
      source: 'en',
      target: 'ko',
      model: 'gpt-5.6-terra',
    }),
  });
  assert.equal(translated.status, 200);
  const translatedJson = await translated.json() as { translation: string; model: string };
  assert.equal(translatedJson.translation, 'T:Hello');
  assert.equal(translatedJson.model, 'gpt-5.6-terra');
  assert.equal(runner.calls.at(-1)?.model, 'gpt-5.6-terra');

  const completion = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'codex-translator',
      messages: [{ role: 'user', content: 'Good night' }],
    }),
  });
  const completionJson = await completion.json() as {
    model: string;
    choices: Array<{ message: { content: string } }>;
  };
  assert.equal(completionJson.choices[0]?.message.content, 'C:Good night');
  assert.equal(completionJson.model, 'gpt-5.6-sol');
  assert.equal(runner.calls.at(-1)?.model, 'gpt-5.6-sol');

  for (const invalidModel of ['gpt-5.5-codex', 'gpt-5.6-unknown', 42]) {
    const rejected = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: invalidModel,
        messages: [{ role: 'user', content: 'Good night' }],
      }),
    });
    assert.equal(rejected.status, 400);
  }

  const streamed = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      stream: true,
      model: 'gpt-5.6-luna',
      messages: [{ role: 'user', content: 'Good night' }],
    }),
  });
  const streamText = await streamed.text();
  assert.match(streamText, /chat\.completion\.chunk/);
  assert.match(streamText, /"model":"gpt-5\.6-luna"/);
  assert.match(streamText, /data: \[DONE\]/);
  assert.equal(runner.calls.at(-1)?.model, 'gpt-5.6-runtime-luna');
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
    batchWindowMs: 1,
    cacheMaxEntries: 100,
    cachePersistent: true,
    defaultSource: 'auto',
    defaultTarget: 'ko',
  };
}
