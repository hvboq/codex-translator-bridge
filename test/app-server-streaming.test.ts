import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexAppServerClient, type TextRunOptions } from '../src/app-server-client.js';
import type { AppConfig } from '../src/config.js';

interface AppServerClientInternals {
  handleNotification(method: string, params: Record<string, unknown>): void;
  waitForTurn(threadId: string, options: TextRunOptions): Promise<string>;
}

test('streams only final-answer deltas and ignores retrying errors', async () => {
  const client = new CodexAppServerClient(testConfig(), () => undefined);
  const internals = client as unknown as AppServerClientInternals;
  const deltas: string[] = [];
  const result = internals.waitForTurn('thread-1', {
    onDelta: (delta) => deltas.push(delta),
  });

  internals.handleNotification('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: 'commentary-1', phase: 'commentary', text: '' },
  });
  internals.handleNotification('item/agentMessage/delta', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'commentary-1',
    delta: 'private commentary',
  });
  internals.handleNotification('error', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    willRetry: true,
    error: { message: 'temporary failure' },
  });
  internals.handleNotification('item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: '' },
  });
  internals.handleNotification('item/agentMessage/delta', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'final-1',
    delta: 'public ',
  });
  internals.handleNotification('item/agentMessage/delta', {
    threadId: 'other-thread',
    turnId: 'turn-2',
    itemId: 'final-1',
    delta: 'other thread',
  });
  internals.handleNotification('item/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'agentMessage',
      id: 'final-1',
      phase: 'final_answer',
      text: 'public answer',
    },
  });
  internals.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    tokenUsage: {
      last: {
        totalTokens: 12,
        inputTokens: 8,
        cachedInputTokens: 3,
        outputTokens: 4,
        reasoningOutputTokens: 1,
      },
    },
  });
  internals.handleNotification('turn/completed', {
    threadId: 'thread-1',
    turn: {
      id: 'turn-1',
      status: 'completed',
      items: [
        {
          type: 'agentMessage',
          id: 'commentary-1',
          phase: 'commentary',
          text: 'private commentary',
        },
        {
          type: 'agentMessage',
          id: 'final-1',
          phase: 'final_answer',
          text: 'public answer',
        },
      ],
    },
  });

  assert.deepEqual(deltas, ['public ']);
  assert.deepEqual(await result, {
    content: 'public answer',
    usage: {
      totalTokens: 12,
      inputTokens: 8,
      cachedInputTokens: 3,
      outputTokens: 4,
      reasoningOutputTokens: 1,
    },
  });
});

test('accepts an intentionally empty final answer', async () => {
  const client = new CodexAppServerClient(testConfig(), () => undefined);
  const internals = client as unknown as AppServerClientInternals;
  const result = internals.waitForTurn('thread-empty', {});
  internals.handleNotification('turn/completed', {
    threadId: 'thread-empty',
    turn: {
      status: 'completed',
      items: [{ type: 'agentMessage', id: 'final-empty', phase: 'final_answer', text: '' }],
    },
  });
  assert.deepEqual(await result, { content: '', usage: null });
});

function testConfig(): AppConfig {
  const directory = path.join(os.tmpdir(), 'codex-bridge-app-server-stream-test');
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
    cachePersistent: false,
    defaultSource: 'auto',
    defaultTarget: 'ko',
  };
}
