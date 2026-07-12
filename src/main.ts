import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { loadLocalAuth } from './auth.js';
import { TranslationCache } from './cache.js';
import { CodexAppServerClient } from './app-server-client.js';
import { TranslationService } from './translation-service.js';
import { GenerationService } from './generation-service.js';
import { createHttpServer } from './http-server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.runtimeDirectory, { recursive: true });

  const localAuth = await loadLocalAuth(config.tokenFile, config.noAuth);
  const cache = new TranslationCache(
    config.cacheFile,
    config.cacheMaxEntries,
    config.cachePersistent,
  );
  await cache.initialize();

  const client = new CodexAppServerClient(config);
  const translations = new TranslationService(config, client, cache);
  const generations = new GenerationService(config, client);
  const server = createHttpServer(config, localAuth.token, client, translations, generations);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log('Codex Bridge listening on http://' + config.host + ':' + config.port);
  if (localAuth.token === null) {
    console.log('Local bearer token check is disabled.');
  } else {
    console.log('Local bearer token file: ' + localAuth.tokenFile);
  }
  console.log('Translation cache entries: ' + cache.size);
  if (localAuth.created) {
    console.log('A new local bearer token was created for OpenAI-compatible clients.');
  }

  void client.getStatus().then((status) => {
    if (status.ready) {
      console.log(
        'Codex ready (auth=' +
          (status.authMode ?? 'none') +
          ', plan=' +
          (status.planType ?? 'unknown') +
          ')',
      );
    } else {
      console.error('Codex unavailable: ' + (status.error ?? 'unknown error'));
    }
  });

  const shutdown = async (signal: string) => {
    console.log('Stopping after ' + signal);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.stop();
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
