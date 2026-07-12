# AGENTS.md

## Project

Codex Translator Bridge is a Windows-first localhost translation service. It exposes dedicated and OpenAI-compatible HTTP endpoints, then runs translations through the official @openai/codex App Server using the user's existing Codex/ChatGPT login.

This is not an offline model, a public API gateway, or a multi-user subscription proxy.

## Architecture

Request flow:

    LunaTranslator/client -> HTTP server -> translation service -> Codex App Server -> ephemeral Codex thread

Key files:

- src/main.ts: application composition, startup, and shutdown.
- src/config.ts: environment parsing, limits, paths, and loopback enforcement.
- src/auth.ts: local bearer-token creation and constant-time validation.
- src/http-server.ts: /translate, /v1/chat/completions, /v1/models, /v1/models/:id, and health routes.
- src/translation-service.ts: validation, micro-batching, in-flight deduplication, caching, and retry.
- src/app-server-client.ts: long-lived stdio JSON-RPC App Server process and ephemeral translation threads.
- src/prompt.ts: translation-only instructions and structured-output schemas.
- src/placeholders.ts: game token, markup, and control-code protection.
- src/cache.ts: bounded in-memory cache plus optional JSONL persistence.
- packaging/windows/: non-developer-facing Windows portable launchers and first-run guide.
- scripts/build-release.ps1: reproducible Windows x64 ZIP builder with Node checksum verification.
- test/: offline unit and HTTP tests using fake structured runners.

## Standard commands

Use Windows-native command shims in PowerShell:

~~~powershell
npm.cmd ci
npm.cmd run codex:status
npm.cmd run codex:login
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run release:windows
~~~

Development and manual verification:

~~~powershell
npm.cmd run dev
.\start.cmd
.\scripts\test-request.ps1
~~~

scripts/test-request.ps1 requires a running bridge. No lint or formatter command is currently configured.

## Coding and tests

- Keep TypeScript strict and compatible with Node.js 18 or newer.
- This is an ESM/NodeNext project. Local TypeScript imports must use .js specifiers.
- Preserve noUncheckedIndexedAccess; narrow optional array and object values explicitly.
- Keep HTTP validation at the boundary and use InputError for client errors.
- Preserve public JSON field names and OpenAI-compatible response shapes.
- Expose only account-visible `gpt-5.6-*` entries from the App Server model catalog. Keep `codex-translator` as an unlisted default alias.
- Preserve the App Server distinction between public model `id` and runtime `model`: echo the resolved ID in HTTP responses, but pass its paired runtime model to `thread/start.model`.
- Resolve aliases before cache or batching decisions. Include the paired runtime model in cache, in-flight deduplication, and batch grouping identities; never re-resolve a runtime model as if it were a public ID.
- Validate CODEX_TRANSLATOR_REASONING_EFFORT against the selected catalog entry when supported efforts are available.
- Inject StructuredRunner fakes in tests; unit tests must not require a Codex login or network access.
- Add tests for changes to routes, authentication, model discovery or selection, batching, cache behavior, input limits, or placeholders.
- Avoid adding dependencies when the Node.js standard library is sufficient.
- If prompts, normalization, or translation semantics change, bump translation-v1 or chat-v1 in the cache identity.

## Security invariants

Do not weaken these without an explicit security review:

- Keep the HTTP server loopback-only. Never allow 0.0.0.0 or a LAN/public bind.
- Keep bearer authentication enabled by default. CODEX_TRANSLATOR_NO_AUTH is only a local compatibility escape hatch.
- Never log, expose, or commit bearer tokens, Codex credentials, source text, or cached translations.
- Treat source text, context, glossary values, and chat messages as untrusted inert data.
- Keep translation threads ephemeral, non-interactive, read-only, and without network access.
- Keep shell, MCP, plugins, apps, browser/computer use, memories, multi-agent features, hooks, and approval requests disabled or declined.
- Preserve structured-output schemas and placeholder validation.
- Preserve request-size, character, batch, queue, and timeout bounds.
- Require bearer authentication for new operational endpoints unless they intentionally expose only non-sensitive loopback health metadata.
- Keep model catalog and model-detail routes authenticated. Do not expose hidden, unavailable, or non-GPT-5.6 App Server models.
- Never expose or copy Codex authentication files through the HTTP API.

## Runtime data

Runtime files live under ignored data/:

- data/token.txt: generated local bearer token.
- data/translations.jsonl: plaintext persistent translation cache.
- data/runtime/: dedicated empty Codex working directory.

Persistent caching is enabled by default and can be disabled with CODEX_TRANSLATOR_PERSIST_CACHE=false. Cache files may contain private game or subtitle text.

The App Server process is long-lived, but every translation batch uses a new ephemeral thread. The SSE endpoint is compatibility streaming: it emits one completed content chunk, a stop chunk, and [DONE]; it is not token-by-token streaming.

## Changes and commits

- Never commit data/, config.ps1, .env, dist/, node_modules/, logs, or temporary files.
- Keep package-lock.json synchronized with dependency changes.
- Keep @openai/codex pinned to an exact version unless an upgrade is deliberately tested.
- Update README.md and config.example.ps1 when endpoints, setup, defaults, or environment variables change.
- Keep repository-authored code and documentation under the root MIT License. Do not vendor third-party code without preserving its original license and documenting it in THIRD_PARTY_NOTICES.md.
- Portable releases must contain no credentials or cache data, must verify the downloaded Node.js archive checksum, and must include third-party license texts.
- Keep commits focused and use clear imperative subjects.
- Before committing, run npm.cmd run check and git diff --check.
- For App Server, authentication, or startup changes, also run a live health/translation smoke test when credentials and network are available.
