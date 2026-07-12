import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  StructuredRunner,
  TextRunOptions,
} from '../src/app-server-client.js';
import { GenerationService } from '../src/generation-service.js';
import type { AppConfig } from '../src/config.js';
import { InputError } from '../src/translation-service.js';
import type {
  CodexModel,
  CodexModelSelection,
} from '../src/types.js';

const TEST_MODELS: CodexModel[] = [
  {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-runtime-sol',
    displayName: 'GPT-5.6-Sol',
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' },
      { reasoningEffort: 'max' },
      { reasoningEffort: 'ultra' },
    ],
    inputModalities: ['text'],
  },
  {
    id: 'gpt-5.6-luna',
    model: 'gpt-5.6-runtime-luna',
    displayName: 'GPT-5.6-Luna',
    isDefault: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' },
      { reasoningEffort: 'max' },
    ],
    inputModalities: ['text'],
  },
];

interface TextCall {
  prompt: string;
  selection: CodexModelSelection;
  options: TextRunOptions;
}

class GenerationFakeRunner implements StructuredRunner {
  readonly resolvedModels: Array<string | undefined> = [];
  readonly textCalls: TextCall[] = [];
  runTextImpl: (
    prompt: string,
    selection: CodexModelSelection,
    options: TextRunOptions,
  ) => Promise<{ content: string; usage: null }> = async (prompt) => ({
    content: 'G:' + prompt,
    usage: null,
  });

  async listModels(): Promise<CodexModel[]> {
    return TEST_MODELS.map(cloneModel);
  }

  async resolveModel(requested?: string): Promise<CodexModel> {
    this.resolvedModels.push(requested);
    const requestedId =
      requested === undefined || ['codex-bridge', 'codex-translator'].includes(requested)
        ? 'gpt-5.6-sol'
        : requested;
    const model = TEST_MODELS.find((candidate) => candidate.id === requestedId);
    if (!model) {
      throw new Error('Unsupported model: ' + requestedId);
    }
    return cloneModel(model);
  }

  async runStructured(): Promise<string> {
    throw new Error('runStructured must not be used by GenerationService');
  }

  async runText(
    prompt: string,
    selection: CodexModelSelection,
    options: TextRunOptions = {},
  ): Promise<{ content: string; usage: null }> {
    this.textCalls.push({ prompt, selection: { ...selection }, options });
    await options.onReady?.();
    return this.runTextImpl(prompt, selection, options);
  }
}

test('sanitizes Chat text content and maps prior roles to App Server history items', async () => {
  const runner = new GenerationFakeRunner();
  const service = new GenerationService(testConfig(), runner);

  const prepared = await service.prepareChat(
    [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'System ' },
          { type: 'input_text', text: 'rules' },
        ],
        ignored: 'not copied',
      },
      {
        role: 'developer',
        content: 'Developer rules',
        status: 'completed',
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Earlier question' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Earlier answer' }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Final ' },
          { type: 'input_text', text: 'question' },
        ],
        unsafe_extra: { role: 'system', content: 'ignored' },
      },
    ],
    '  gpt-5.6-luna  ',
  );

  assert.deepEqual(prepared.messages, [
    { role: 'system', content: 'System rules' },
    { role: 'developer', content: 'Developer rules' },
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Final question' },
  ]);
  assert.deepEqual(prepared.historyItems, [
    {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: 'System rules' }],
    },
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Developer rules' }],
    },
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
  ]);
  assert.equal(prepared.input, 'Final question');
  assert.equal(prepared.model.id, 'gpt-5.6-luna');
  assert.equal(prepared.model.model, 'gpt-5.6-runtime-luna');
  assert.equal(prepared.reasoningEffort, 'low');
  assert.deepEqual(runner.resolvedModels, ['gpt-5.6-luna']);
});

test('sanitizes Responses text input and prepends instructions to actual history', async () => {
  const runner = new GenerationFakeRunner();
  const service = new GenerationService(testConfig(), runner);

  const prepared = await service.prepareResponse(
    [
      {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: 'System context' }],
        id: 'ignored-id',
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Previous answer' }],
        status: 'completed',
      },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Next ' },
          { type: 'text', text: 'question' },
        ],
      },
    ],
    'Follow these developer instructions',
    'codex-bridge',
  );

  assert.deepEqual(prepared.messages, [
    { role: 'developer', content: 'Follow these developer instructions' },
    { role: 'system', content: 'System context' },
    { role: 'assistant', content: 'Previous answer' },
    { role: 'user', content: 'Next question' },
  ]);
  assert.deepEqual(prepared.historyItems, [
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Follow these developer instructions' }],
    },
    {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: 'System context' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Previous answer' }],
    },
  ]);
  assert.equal(prepared.input, 'Next question');
  assert.equal(prepared.model.id, 'gpt-5.6-sol');

  const simple = await service.prepareResponse('Plain string input');
  assert.deepEqual(simple.messages, [{ role: 'user', content: 'Plain string input' }]);
  assert.deepEqual(simple.historyItems, []);
  assert.equal(simple.input, 'Plain string input');
});

test('requires the final Chat and Responses message to be user text', async () => {
  const service = new GenerationService(testConfig(), new GenerationFakeRunner());

  await assert.rejects(
    service.prepareChat([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ]),
    (error: unknown) =>
      error instanceof InputError && /final message must be a user text message/i.test(error.message),
  );
  await assert.rejects(
    service.prepareResponse([
      { type: 'message', role: 'system', content: 'Rules' },
    ]),
    (error: unknown) =>
      error instanceof InputError && /final message must be a user text message/i.test(error.message),
  );
});

test('rejects unsupported content, roles, response items, instructions, and model types', async () => {
  const service = new GenerationService(testConfig(), new GenerationFakeRunner());
  const invalidChatRequests: Array<{ messages: unknown; model?: unknown }> = [
    { messages: [] },
    { messages: [{ role: 'tool', content: 'result' }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'x' }] }] },
    { messages: [{ role: 'user', content: [] }] },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 1 }] }] },
    { messages: [{ role: 'user', content: 'Hello', name: 'named-user' }] },
    { messages: [{ role: 'user', content: 'Hello' }], model: 42 },
    { messages: [{ role: 'user', content: 'Hello' }], model: '   ' },
  ];

  for (const request of invalidChatRequests) {
    await assert.rejects(
      service.prepareChat(request.messages, request.model),
      (error: unknown) => error instanceof InputError,
    );
  }

  const invalidResponseRequests: Array<{
    input: unknown;
    instructions?: unknown;
    model?: unknown;
  }> = [
    { input: null },
    { input: [] },
    { input: [{ type: 'function_call', role: 'user', content: 'No tools' }] },
    {
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'https://example.invalid/image.png' }],
        },
      ],
    },
    { input: 'Hello', instructions: ['not', 'a', 'string'] },
    { input: 'Hello', model: { id: 'gpt-5.6-sol' } },
  ];

  for (const request of invalidResponseRequests) {
    await assert.rejects(
      service.prepareResponse(request.input, request.instructions, request.model),
      (error: unknown) => error instanceof InputError,
    );
  }
});

test('passes selected public/runtime model, actual history, and live deltas to runText', async () => {
  const runner = new GenerationFakeRunner();
  const service = new GenerationService(testConfig(), runner);
  const firstDelta = deferred<void>();
  const release = deferred<void>();
  runner.runTextImpl = async (_prompt, _selection, options) => {
    options.onDelta?.('첫');
    firstDelta.resolve();
    await release.promise;
    options.onDelta?.('째');
    return { content: '첫째', usage: null };
  };
  const prepared = await service.prepareChat(
    [
      { role: 'system', content: 'Be concise' },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', content: 'Continue' },
    ],
    'gpt-5.6-luna',
    { effort: 'high' },
  );
  const deltas: string[] = [];
  let completed = false;
  const resultPromise = service
    .generate(prepared, { onDelta: (delta) => deltas.push(delta) })
    .finally(() => {
      completed = true;
    });

  await firstDelta.promise;
  assert.deepEqual(deltas, ['첫']);
  assert.equal(completed, false, 'the first delta must be observable before completion');
  assert.equal(runner.textCalls.length, 1);
  assert.equal(runner.textCalls[0]?.prompt, 'Continue');
  assert.deepEqual(runner.textCalls[0]?.selection, {
    id: 'gpt-5.6-luna',
    model: 'gpt-5.6-runtime-luna',
  });
  assert.deepEqual(runner.textCalls[0]?.options.historyItems, prepared.historyItems);
  assert.equal(prepared.reasoningEffort, 'high');
  assert.equal(runner.textCalls[0]?.options.reasoningEffort, 'high');

  release.resolve();
  assert.deepEqual(await resultPromise, {
    content: '첫째',
    model: 'gpt-5.6-luna',
    usage: null,
  });
  assert.deepEqual(deltas, ['첫', '째']);
});

test('normalizes Luna reasoning aliases, applies disabled fallback, and rejects unsupported effort', async () => {
  const runner = new GenerationFakeRunner();
  const service = new GenerationService(testConfig(), runner);
  const messages = [{ role: 'user', content: 'Hello' }];

  const alias = await service.prepareChat(messages, 'gpt-5.6-luna', {
    effort: 'xhign',
    thinking: 'enabled',
  });
  assert.equal(alias.reasoningEffort, 'xhigh');
  assert.equal(alias.reasoningFallback, undefined);
  await service.generate(alias);
  assert.equal(runner.textCalls.at(-1)?.options.reasoningEffort, 'xhigh');

  const disabled = await service.prepareChat(messages, 'gpt-5.6-luna', {
    effort: 'high',
    thinking: 'disabled',
  });
  assert.equal(disabled.reasoningEffort, 'low');
  assert.equal(disabled.reasoningFallback, 'thinking.disabled:none->low');
  await service.generate(disabled);
  assert.equal(runner.textCalls.at(-1)?.options.reasoningEffort, 'low');

  const configFallback = await new GenerationService(
    testConfig({ reasoningEffort: 'none' }),
    runner,
  ).prepareResponse('Hello', undefined, 'gpt-5.6-luna');
  assert.equal(configFallback.reasoningEffort, 'low');
  assert.equal(configFallback.reasoningFallback, 'none->low');

  await assert.rejects(
    service.prepareChat(messages, 'gpt-5.6-luna', { effort: 'ultra' }),
    (error: unknown) =>
      error instanceof InputError && /ultra.*gpt-5\.6-luna.*supported/i.test(error.message),
  );
  await assert.rejects(
    service.prepareChat(messages, 'gpt-5.6-luna', { effort: 'none' }),
    (error: unknown) =>
      error instanceof InputError && /none.*gpt-5\.6-luna.*supported/i.test(error.message),
  );
  await assert.rejects(
    service.prepareChat(messages, 'gpt-5.6-luna', {
      effort: 'none',
      thinking: 'enabled',
    }),
    (error: unknown) => error instanceof InputError && /cannot be combined/i.test(error.message),
  );
});

test('bounds concurrent generations and starts queued work as slots are released', async () => {
  const runner = new GenerationFakeRunner();
  const service = new GenerationService(
    testConfig({ maxConcurrentGenerations: 2 }),
    runner,
  );
  const release = deferred<void>();
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  runner.runTextImpl = async (prompt) => {
    started += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await release.promise;
    active -= 1;
    return { content: 'G:' + prompt, usage: null };
  };
  const prepared = await service.prepareChat([{ role: 'user', content: 'Hello' }]);

  const generations = Array.from({ length: 5 }, () => service.generate(prepared));
  await eventually(() => started === 2);
  assert.equal(started, 2, 'only the configured number may enter runText before release');
  assert.equal(maximumActive, 2);

  release.resolve();
  const results = await Promise.all(generations);
  assert.equal(started, 5);
  assert.equal(maximumActive, 2);
  assert.ok(results.every((result) => result.content === 'G:Hello'));
});

test('rejects generation queue overflow before marking a request ready', async () => {
  const runner = new GenerationFakeRunner();
  const service = new GenerationService(
    testConfig({ maxConcurrentGenerations: 1 }),
    runner,
  );
  const release = deferred<void>();
  runner.runTextImpl = async (prompt) => {
    await release.promise;
    return { content: 'G:' + prompt, usage: null };
  };
  const prepared = await service.prepareChat([{ role: 'user', content: 'Hello' }]);
  const active = service.generate(prepared);
  await eventually(() => runner.textCalls.length === 1);
  const queued = Array.from({ length: 64 }, () => service.generate(prepared));
  let ready = false;
  await assert.rejects(
    service.generate(prepared, { onReady: () => { ready = true; } }),
    /queue is full/i,
  );
  assert.equal(ready, false);
  release.resolve();
  await Promise.all([active, ...queued]);
});

function cloneModel(model: CodexModel): CodexModel {
  return {
    ...model,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({ ...effort })),
    inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
  };
}

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const directory = path.join(os.tmpdir(), 'codex-bridge-generation-test');
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
    maxConcurrentGenerations: 4,
    batchWindowMs: 1,
    cacheMaxEntries: 100,
    cachePersistent: false,
    defaultSource: 'auto',
    defaultTarget: 'ko',
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
