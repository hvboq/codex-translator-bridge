import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const MANAGED_ENV = [
  'CODEX_BRIDGE_HOME',
  'CODEX_TRANSLATOR_HOME',
  'CODEX_BRIDGE_HOST',
  'CODEX_TRANSLATOR_HOST',
  'CODEX_BRIDGE_PORT',
  'CODEX_TRANSLATOR_PORT',
  'CODEX_BRIDGE_MAX_CONCURRENCY',
  'CODEX_TRANSLATOR_MAX_CONCURRENCY',
] as const;

test('prefers CODEX_BRIDGE settings and falls back to v0.1 names', () => {
  const saved = new Map<string, string | undefined>(
    MANAGED_ENV.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of MANAGED_ENV) {
      delete process.env[name];
    }
    const legacyHome = path.join(os.tmpdir(), 'legacy-codex-bridge-home');
    process.env.CODEX_TRANSLATOR_HOME = legacyHome;
    process.env.CODEX_TRANSLATOR_PORT = '9001';
    process.env.CODEX_TRANSLATOR_MAX_CONCURRENCY = '3';

    const legacy = loadConfig();
    assert.equal(legacy.port, 9001);
    assert.equal(legacy.maxConcurrentGenerations, 3);
    assert.equal(legacy.dataDirectory, path.join(legacyHome, 'data'));

    const canonicalHome = path.join(os.tmpdir(), 'canonical-codex-bridge-home');
    process.env.CODEX_BRIDGE_HOME = canonicalHome;
    process.env.CODEX_BRIDGE_PORT = '9002';
    process.env.CODEX_BRIDGE_MAX_CONCURRENCY = '5';

    const canonical = loadConfig();
    assert.equal(canonical.port, 9002);
    assert.equal(canonical.maxConcurrentGenerations, 5);
    assert.equal(canonical.dataDirectory, path.join(canonicalHome, 'data'));
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
