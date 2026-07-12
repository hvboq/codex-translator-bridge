import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  UnsupportedModelError,
  type StructuredRunner,
  type TextRunOptions,
} from '../src/app-server-client.js';
import { TranslationCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { GenerationService } from '../src/generation-service.js';
import { createHttpServer } from '../src/http-server.js';
import { TranslationService } from '../src/translation-service.js';
import type { CodexModel, CodexModelSelection } from '../src/types.js';

const HTTP_MODELS: CodexModel[] = [
  model('gpt-5.6-sol', 'gpt-5.6-sol', true, [
    'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
  ]),
  model('gpt-5.6-terra', 'gpt-5.6-terra', false, [
    'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
  ]),
  model('gpt-5.6-luna', 'gpt-5.6-runtime-luna', false, [
    'low', 'medium', 'high', 'xhigh', 'max',
  ]),
  model('gpt-5.5-codex', 'gpt-5.5-codex'),
];

class HttpFakeRunner implements StructuredRunner {
  readonly abortedPrompts: string[] = [];
  readonly structuredCalls: Array<{ model: string; prompt: string }> = [];
  readonly textCalls: Array<{
    developerInstructions?: string;
    historyItems: Array<Record<string, unknown>>;
    model: string;
    prompt: string;
    reasoningEffort?: string;
    systemInstructions?: string;
  }> = [];

  async listModels(): Promise<CodexModel[]> {
    return HTTP_MODELS.map((entry) => structuredClone(entry));
  }

  async resolveModel(requested?: string): Promise<CodexModel> {
    const aliases = new Set(['codex-bridge', 'codex-translator']);
    const value = !requested || aliases.has(requested) ? 'gpt-5.6-sol' : requested;
    const selected = HTTP_MODELS.find(
      (entry) =>
        entry.model.startsWith('gpt-5.6-') &&
        (entry.id === value || entry.model === value),
    );
    if (!selected) {
      throw new UnsupportedModelError(value, HTTP_MODELS.slice(0, 3).map((entry) => entry.id));
    }
    return structuredClone(selected);
  }

  async runStructured(
    prompt: string,
    _schema: object,
    selection: CodexModelSelection,
  ): Promise<string> {
    this.structuredCalls.push({ model: selection.model, prompt });
    const values = JSON.parse(prompt.split('INPUT_JSON:\n')[1] ?? '[]') as Array<{
      source_text: string;
    }>;
    return JSON.stringify({ translations: values.map((value) => 'T:' + value.source_text) });
  }

  async runText(
    prompt: string,
    selection: CodexModelSelection,
    options: TextRunOptions = {},
  ): Promise<{
    content: string;
    usage: {
      totalTokens: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
    };
  }> {
    this.textCalls.push({
      developerInstructions: options.developerInstructions,
      historyItems: structuredClone(options.historyItems ?? []),
      model: selection.model,
      prompt,
      reasoningEffort: options.reasoningEffort,
      systemInstructions: options.systemInstructions,
    });
    await options.onReady?.();
    if (prompt === 'FAIL') {
      options.onDelta?.('partial');
      throw new Error('synthetic generation failure');
    }
    if (prompt === 'WAIT') {
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          this.abortedPrompts.push(prompt);
          reject(new Error('synthetic cancellation'));
        };
        if (options.signal?.aborted) {
          abort();
        } else {
          options.signal?.addEventListener('abort', abort, { once: true });
        }
      });
    }
    const parts = ['G:', prompt];
    for (const part of parts) {
      options.onDelta?.(part);
    }
    return {
      content: parts.join(''),
      usage: {
        totalTokens: 15,
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 1,
      },
    };
  }
}

test('serves general OpenAI-compatible APIs and keeps translate optional', async (context) => {
  const fixture = await startFixture(context);
  const { base, runner } = fixture;

  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { auth_mode: string }).auth_mode, 'chatgpt');

  const root = await fetch(base + '/');
  assert.equal((await root.json() as { name: string }).name, 'Codex Bridge');

  for (const pathName of ['/v1/models', '/v1/chat/completions', '/v1/responses']) {
    const unauthorized = await fetch(base + pathName, {
      method: pathName === '/v1/models' ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: pathName === '/v1/models' ? undefined : '{}',
    });
    assert.equal(unauthorized.status, 401);
  }

  const models = await authorizedFetch(base + '/v1/models');
  assert.deepEqual(
    ((await models.json()) as { data: Array<{ id: string }> }).data.map((entry) => entry.id),
    ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  );

  const translated = await authorizedFetch(base + '/translate', {
    method: 'POST',
    body: JSON.stringify({ text: 'Hello', target: 'ko', model: 'gpt-5.6-terra' }),
  });
  assert.equal(translated.status, 200);
  const translatedJson = await translated.json() as {
    translation: string;
    translations: string[];
    cached: boolean;
    duration_ms: number;
    engine: string;
    model: string;
  };
  assert.equal(translatedJson.translation, 'T:Hello');
  assert.deepEqual(translatedJson.translations, ['T:Hello']);
  assert.equal(translatedJson.cached, false);
  assert.equal(translatedJson.engine, 'codex');
  assert.equal(translatedJson.model, 'gpt-5.6-terra');
  assert.ok(translatedJson.duration_ms >= 0);
  assert.equal(runner.structuredCalls.at(-1)?.model, 'gpt-5.6-terra');

  const completion = await authorizedFetch(base + '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'codex-bridge',
      messages: [
        { role: 'system', content: 'Answer in Korean.' },
        { role: 'developer', content: 'Be concise.' },
        { role: 'assistant', content: 'Ready.' },
        { role: 'user', content: 'Hello' },
      ],
    }),
  });
  const completionJson = await completion.json() as {
    model: string;
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  assert.equal(completionJson.model, 'gpt-5.6-sol');
  assert.equal(completionJson.choices[0]?.message.content, 'G:Hello');
  assert.deepEqual(completionJson.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 2, audio_tokens: 0 },
    completion_tokens_details: {
      reasoning_tokens: 1,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  });
  assert.equal(runner.textCalls.at(-1)?.prompt, 'Hello');
  assert.equal(runner.textCalls.at(-1)?.systemInstructions, 'Answer in Korean.');
  assert.equal(runner.textCalls.at(-1)?.developerInstructions, 'Be concise.');
  assert.deepEqual(runner.textCalls.at(-1)?.historyItems, [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Ready.' }],
    },
  ]);

  const response = await authorizedFetch(base + '/v1/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      instructions: 'Answer briefly.',
      input: [
        { type: 'message', role: 'system', content: 'Answer in Korean.' },
        { type: 'message', role: 'user', content: 'Status?' },
      ],
    }),
  });
  const responseJson = await response.json() as {
    object: string;
    output_text: string;
    model: string;
    output: Array<{ content: Array<{ text: string }> }>;
    usage: { total_tokens: number; input_tokens: number; output_tokens: number };
  };
  assert.equal(responseJson.object, 'response');
  assert.equal(responseJson.model, 'gpt-5.6-luna');
  assert.equal(responseJson.output_text, 'G:Status?');
  assert.equal(responseJson.output[0]?.content[0]?.text, 'G:Status?');
  assert.equal(responseJson.usage.total_tokens, 15);
  assert.equal(responseJson.usage.input_tokens, 10);
  assert.equal(responseJson.usage.output_tokens, 5);
  assert.equal(runner.textCalls.at(-1)?.model, 'gpt-5.6-runtime-luna');
  assert.equal(runner.textCalls.at(-1)?.systemInstructions, 'Answer in Korean.');
  assert.equal(runner.textCalls.at(-1)?.developerInstructions, 'Answer briefly.');
  assert.deepEqual(runner.textCalls.at(-1)?.historyItems, []);
});

test('streams real Chat deltas and typed Responses events in order', async (context) => {
  const { base, runner } = await startFixture(context);

  const chat = await authorizedFetch(base + '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      stream_options: { include_usage: true },
      model: 'gpt-5.6-luna',
      max_tokens: 1024,
      temperature: 0,
      top_p: 0.3,
      reasoning_effort: 'xhign',
      thinking: { type: 'enabled' },
      messages: [
        { role: 'system', content: 'Stream in Korean.' },
        { role: 'developer', content: 'Keep it short.' },
        { role: 'user', content: 'Hello' },
      ],
    }),
  });
  assert.match(chat.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(
    chat.headers.get('x-codex-bridge-advisory-parameters'),
    'max_tokens, temperature, top_p',
  );
  assert.equal(chat.headers.get('x-codex-bridge-reasoning-effort'), 'xhigh');
  assert.equal(chat.headers.get('x-codex-bridge-reasoning-fallback'), null);
  const chatFrames = parseDataFrames(await chat.text());
  assert.equal(chatFrames.at(-1), '[DONE]');
  const chatChunks = chatFrames.slice(0, -1).map((frame) => JSON.parse(frame));
  assert.equal(chatChunks[0].choices[0].delta.role, 'assistant');
  assert.equal(
    chatChunks.slice(1, -2).map((chunk) => chunk.choices[0].delta.content ?? '').join(''),
    'G:Hello',
  );
  assert.equal(chatChunks.at(-2).choices[0].finish_reason, 'stop');
  assert.deepEqual(chatChunks.at(-1).choices, []);
  assert.equal(chatChunks.at(-1).usage.total_tokens, 15);
  assert.equal(runner.textCalls.at(-1)?.model, 'gpt-5.6-runtime-luna');
  assert.equal(runner.textCalls.at(-1)?.reasoningEffort, 'xhigh');
  assert.equal(runner.textCalls.at(-1)?.systemInstructions, 'Stream in Korean.');
  assert.equal(runner.textCalls.at(-1)?.developerInstructions, 'Keep it short.');

  const responses = await authorizedFetch(base + '/v1/responses', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      model: 'gpt-5.6-sol',
      instructions: 'Keep it short.',
      input: 'Hello',
      reasoning: { effort: 'high' },
    }),
  });
  assert.equal(responses.headers.get('x-codex-bridge-reasoning-effort'), 'high');
  const responseEvents = parseTypedEvents(await responses.text());
  assert.deepEqual(responseEvents.map((entry) => entry.type), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  assert.deepEqual(
    responseEvents.map((entry) => entry.data.sequence_number),
    responseEvents.map((_, index) => index),
  );
  assert.equal(
    responseEvents
      .filter((entry) => entry.type === 'response.output_text.delta')
      .map((entry) => entry.data.delta)
      .join(''),
    'G:Hello',
  );
  assert.ok(!responseEvents.some((entry) => JSON.stringify(entry.data).includes('[DONE]')));
  const responseSnapshots = responseEvents
    .map((entry) => entry.data.response as { reasoning?: { effort?: string } } | undefined)
    .filter((entry): entry is { reasoning: { effort?: string } } => entry !== undefined);
  assert.ok(responseSnapshots.length >= 3);
  assert.ok(responseSnapshots.every((entry) => entry.reasoning.effort === 'high'));
  assert.equal(runner.textCalls.at(-1)?.reasoningEffort, 'high');
  assert.equal(runner.textCalls.at(-1)?.developerInstructions, 'Keep it short.');
});

test('accepts validated max token aliases used by OpenAI-compatible clients', async (context) => {
  const { base } = await startFixture(context);

  const chat = await authorizedFetch(base + '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      max_completion_tokens: 2048,
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  });
  assert.equal(chat.status, 200);
  assert.equal(
    chat.headers.get('x-codex-bridge-advisory-parameters'),
    'max_completion_tokens',
  );

  const response = await authorizedFetch(base + '/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ max_output_tokens: 512, input: 'Hello' }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('x-codex-bridge-advisory-parameters'),
    'max_output_tokens',
  );

  const unspecified = await authorizedFetch(base + '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      max_tokens: null,
      temperature: null,
      top_p: null,
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  });
  assert.equal(unspecified.status, 200);
  assert.equal(unspecified.headers.get('x-codex-bridge-advisory-parameters'), null);
});

test('maps Luna thinking controls and echoes the effective Responses effort', async (context) => {
  const { base, runner } = await startFixture(context);

  const chat = await authorizedFetch(base + '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      reasoning_effort: 'high',
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('x-codex-bridge-reasoning-effort'), 'low');
  assert.equal(
    chat.headers.get('x-codex-bridge-reasoning-fallback'),
    'thinking.disabled:none->low',
  );
  assert.equal(runner.textCalls.at(-1)?.reasoningEffort, 'low');

  const response = await authorizedFetch(base + '/v1/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-5.6-sol',
      input: 'Hello',
      reasoning: { effort: 'max', summary: null },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { reasoning: { effort: string; summary: null } };
  assert.deepEqual(body.reasoning, { effort: 'max', summary: null });
  assert.equal(response.headers.get('x-codex-bridge-reasoning-effort'), 'max');
  assert.equal(runner.textCalls.at(-1)?.reasoningEffort, 'max');
});

test('rejects invalid and model-specific reasoning controls before SSE starts', async (context) => {
  const { base, runner } = await startFixture(context);
  const cases: Array<{ path: string; body: Record<string, unknown> }> = [
    {
      path: '/v1/chat/completions',
      body: { reasoning_effort: 42 },
    },
    {
      path: '/v1/chat/completions',
      body: { reasoning_effort: 'extreme' },
    },
    {
      path: '/v1/chat/completions',
      body: { model: 'gpt-5.6-luna', reasoning_effort: 'none' },
    },
    {
      path: '/v1/chat/completions',
      body: { reasoning_effort: 'none', thinking: { type: 'enabled' } },
    },
    {
      path: '/v1/chat/completions',
      body: { thinking: 'enabled' },
    },
    {
      path: '/v1/chat/completions',
      body: { thinking: {} },
    },
    {
      path: '/v1/chat/completions',
      body: { thinking: { type: 'auto' } },
    },
    {
      path: '/v1/chat/completions',
      body: { thinking: { type: 'enabled', budget_tokens: 1 } },
    },
    {
      path: '/v1/responses',
      body: { reasoning: 'high' },
    },
    {
      path: '/v1/responses',
      body: { reasoning: { effort: 42 } },
    },
    {
      path: '/v1/responses',
      body: { reasoning: { effort: 'high', summary: 'auto' } },
    },
  ];
  for (const fixture of cases) {
    const isChat = fixture.path.endsWith('/chat/completions');
    const response = await authorizedFetch(base + fixture.path, {
      method: 'POST',
      body: JSON.stringify({
        ...fixture.body,
        ...(isChat
          ? { messages: [{ role: 'user', content: 'Hello' }] }
          : { input: 'Hello' }),
      }),
    });
    assert.equal(response.status, 400, JSON.stringify(fixture.body));
  }

  const callsBefore = runner.textCalls.length;
  const unsupported = await authorizedFetch(base + '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      model: 'gpt-5.6-luna',
      max_tokens: 10,
      reasoning_effort: 'ultra',
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  });
  assert.equal(unsupported.status, 400);
  assert.match(unsupported.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(unsupported.headers.get('x-codex-bridge-advisory-parameters'), null);
  assert.equal(unsupported.headers.get('x-codex-bridge-reasoning-effort'), null);
  const error = await unsupported.json() as { error: { message: string; type: string } };
  assert.equal(error.error.type, 'invalid_request_error');
  assert.match(error.error.message, /ultra.*gpt-5\.6-luna.*low.*max/i);
  assert.equal(runner.textCalls.length, callsBefore);
});

test('rejects unsupported multimodal, tool, stateful, and invalid model requests', async (context) => {
  const { base } = await startFixture(context);
  const cases: Array<{ path: string; body: unknown }> = [
    {
      path: '/v1/chat/completions',
      body: { messages: [{ role: 'user', content: 'Hi' }], tools: [{ type: 'function' }] },
    },
    {
      path: '/v1/chat/completions',
      body: { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 0 },
    },
    {
      path: '/v1/chat/completions',
      body: {
        messages: [{ role: 'user', content: 'Hi' }],
        max_completion_tokens: 1.5,
      },
    },
    {
      path: '/v1/chat/completions',
      body: { messages: [{ role: 'user', content: 'Hi' }], temperature: 2.1 },
    },
    {
      path: '/v1/chat/completions',
      body: { messages: [{ role: 'user', content: 'Hi' }], top_p: '0.3' },
    },
    {
      path: '/v1/chat/completions',
      body: {
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
        ],
      },
    },
    { path: '/v1/chat/completions', body: { model: 'gpt-5.5-codex', messages: [] } },
    { path: '/v1/responses', body: { input: 'Hi', store: true } },
    { path: '/v1/responses', body: { input: 'Hi', max_output_tokens: -1 } },
    { path: '/v1/responses', body: { input: 'Hi', previous_response_id: 'resp_old' } },
    {
      path: '/v1/responses',
      body: {
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }],
          },
        ],
      },
    },
  ];
  for (const fixture of cases) {
    const response = await authorizedFetch(base + fixture.path, {
      method: 'POST',
      body: JSON.stringify(fixture.body),
    });
    assert.equal(response.status, 400, fixture.path + ': ' + JSON.stringify(fixture.body));
  }
});

test('terminates failed streams without a successful completion marker', async (context) => {
  const { base } = await startFixture(context);
  const chat = await authorizedFetch(base + '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: 'FAIL' }],
    }),
  });
  const chatText = await chat.text();
  assert.match(chatText, /synthetic generation failure/);
  assert.doesNotMatch(chatText, /"finish_reason":"stop"/);
  assert.doesNotMatch(chatText, /data: \[DONE\]/);

  const response = await authorizedFetch(base + '/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ stream: true, input: 'FAIL' }),
  });
  const events = parseTypedEvents(await response.text());
  assert.deepEqual(events.slice(-2).map((entry) => entry.type), ['error', 'response.failed']);
  assert.ok(!events.some((entry) => entry.type === 'response.completed'));
});

test('cancels a non-streaming Codex generation when the client disconnects', async (context) => {
  const { base, runner } = await startFixture(context);
  const controller = new AbortController();
  const pending = authorizedFetch(base + '/v1/chat/completions', {
    method: 'POST',
    signal: controller.signal,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'WAIT' }] }),
  });
  await eventually(() => runner.textCalls.some((call) => call.prompt === 'WAIT'));
  controller.abort();
  await assert.rejects(pending, /abort/i);
  await eventually(() => runner.abortedPrompts.includes('WAIT'));
});

async function startFixture(context: TestContext): Promise<{
  base: string;
  runner: HttpFakeRunner;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-bridge-http-test-'));
  const config = testConfig(directory);
  const cache = new TranslationCache(config.cacheFile, 100);
  await cache.initialize();
  const runner = new HttpFakeRunner();
  const translations = new TranslationService(config, runner, cache);
  const generations = new GenerationService(config, runner);
  const status = {
    async getStatus() {
      return { ready: true, authMode: 'chatgpt', planType: 'test' };
    },
  };
  const server = createHttpServer(
    config,
    'local-secret',
    status,
    translations,
    generations,
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    base: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    runner,
  };
}

function authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      authorization: 'Bearer local-secret',
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

function parseDataFrames(value: string): string[] {
  return value
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.split(/\r?\n/).find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line) => line.slice('data: '.length));
}

function parseTypedEvents(value: string): Array<{ type: string; data: any }> {
  return value
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const type = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
      const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length);
      assert.ok(type);
      assert.ok(data);
      const parsed = JSON.parse(data);
      assert.equal(parsed.type, type);
      return { type, data: parsed };
    });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Condition was not met before the test deadline');
}

function model(
  id: string,
  runtimeModel: string,
  isDefault = false,
  efforts: string[] = ['low'],
): CodexModel {
  return {
    id,
    model: runtimeModel,
    displayName: id,
    isDefault,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    inputModalities: ['text'],
  };
}

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
    maxConcurrentGenerations: 2,
    batchWindowMs: 1,
    cacheMaxEntries: 100,
    cachePersistent: true,
    defaultSource: 'auto',
    defaultTarget: 'ko',
  };
}
