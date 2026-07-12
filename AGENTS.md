# AGENTS.md

## Project

Codex Bridge is a Windows-first localhost OpenAI-compatible text gateway. It uses the official `@openai/codex` App Server and the user's own Codex/ChatGPT login. General text generation is the primary surface; translation is an optional specialized route.

This is not an offline model, a full OpenAI API implementation, a public gateway, or a multi-user subscription proxy.

## Architecture

```text
OpenAI-compatible client -> HTTP server -> generation service -> Codex App Server
Translation client       -> HTTP server -> translation service -> Codex App Server
```

Key files:

- `src/main.ts`: composition, startup, and shutdown.
- `src/config.ts`: canonical `CODEX_BRIDGE_*` configuration plus v0.1 fallback names.
- `src/auth.ts`: local bearer-token creation and constant-time validation.
- `src/http-server.ts`: models, Chat Completions, Responses, translation, health, and SSE mapping.
- `src/generation-service.ts`: text-only Chat/Responses normalization, sanitized history injection, concurrency bounds, and general execution.
- `src/translation-service.ts`: translation validation, micro-batching, cache, placeholder restoration, and retry.
- `src/app-server-client.ts`: long-lived stdio JSON-RPC process, model catalog, ephemeral threads, live final-answer deltas, cancellation, and security policy.
- `src/prompt.ts`: strictly separated general and translation instruction profiles.
- `src/placeholders.ts`: game token, markup, and control-code protection for `/translate`.
- `src/cache.ts`: bounded translation cache plus optional JSONL persistence.
- `packaging/windows/`: non-developer Windows portable launchers and guide.
- `scripts/build-release.ps1`: reproducible Windows x64 ZIP builder with Node checksum verification.
- `test/`: offline service and HTTP/SSE tests using fake runners.

## Standard commands

Use Windows-native command shims in PowerShell:

```powershell
npm.cmd ci
npm.cmd run codex:status
npm.cmd run codex:login
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run release:windows
```

Manual verification:

```powershell
npm.cmd run dev
.\start.cmd
.\scripts\test-request.ps1
```

## API invariants

- `GET /v1/models` exposes only account-visible `gpt-5.6-*` models.
- Keep public model `id` separate from runtime `model`; return the ID over HTTP and pass its paired runtime value to Codex.
- `codex-bridge` is the canonical unlisted default alias. Keep `codex-translator` as a v0.1 compatibility alias.
- Chat and Responses are text-only compatibility subsets. Reject unsupported image, audio, file, tool, function, stateful, background, or stored-response behavior instead of silently ignoring it.
- Map normalized Chat/Responses `system` messages to App Server `thread/start.baseInstructions`, and `developer` messages plus Responses top-level `instructions` to `developerInstructions`. Inject only prior `user`/`assistant` messages as history. Compose fixed bridge security profiles after client instructions so request content cannot textually override tool, sandbox, network, or privacy restrictions.
- Validate and accept Chat `max_tokens`, `max_completion_tokens`, `temperature`, and `top_p`, plus Responses `max_output_tokens`, as explicitly documented advisory compatibility parameters. List present non-null fields in `X-Codex-Bridge-Advisory-Parameters`; treat explicit `null` as unspecified, and do not claim or imply hard enforcement until App Server exposes it.
- Normalize and pass Chat `reasoning_effort` and Responses `reasoning.effort` to App Server `turn/start.effort`; validate against the selected model before SSE starts. Support Luna `thinking.type` (`enabled`/`disabled`) and its `xhign` typo. Lowest-effort fallback is only for `thinking.type=disabled` and configured defaults; reject unsupported explicit standard effort values. Expose the effective value without streaming reasoning content.
- Chat streaming uses incremental `chat.completion.chunk` frames and `[DONE]`.
- Responses streaming uses typed events ending in `response.completed`, without `[DONE]`.
- Stream only `agentMessage` items whose phase is `final_answer`; never expose commentary, reasoning, plans, or tool events.
- Validate and resolve requests before sending SSE headers.
- General Chat/Responses generations are not persistently cached or micro-batched.
- `/translate` retains model-separated micro-batching, in-flight deduplication, persistent cache, structured output, and placeholder protection.

## Coding and tests

- Keep TypeScript strict, ESM/NodeNext, Node.js 18+, `.js` local import specifiers, and `noUncheckedIndexedAccess`.
- Keep HTTP validation at the boundary and use `InputError` for client errors.
- Reconstruct sanitized App Server history items; never forward arbitrary client-supplied Responses items.
- Inject `StructuredRunner` fakes in unit tests; offline tests must not require login or network.
- Add exact SSE event-order tests for streaming changes.
- Preserve concurrency and queue bounds, cancellation, timeouts, and `thread/unsubscribe` cleanup.
- Avoid dependencies when the Node.js standard library is sufficient.
- If translation prompts or semantics change, bump the `translation-v2` cache identity.

## Security invariants

Do not weaken these without explicit security review:

- HTTP remains loopback-only; never allow `0.0.0.0`, LAN, or public binds.
- Bearer authentication remains enabled by default. `CODEX_BRIDGE_NO_AUTH` is a local compatibility escape hatch only.
- Never log, expose, or commit bearer tokens, Codex credentials, request text, or cached translations.
- All threads remain ephemeral, non-interactive, read-only, network-disabled, and `approvalPolicy: never`.
- Shell, MCP, plugins, apps, browser/computer use, memories, multi-agent, hooks, and approval paths remain disabled or declined.
- Ignore request-controlled `cwd`, tools, permissions, and local paths.
- Require bearer authentication for model and operational endpoints except the intentionally minimal root and health routes.
- Never expose or copy Codex authentication files through HTTP or release assets.

## Configuration compatibility

Canonical names use `CODEX_BRIDGE_*`. v0.1 `CODEX_TRANSLATOR_*` names remain lower-priority fallbacks for one-step migration. When both are set, the canonical name wins. New documentation and examples must use only canonical names except migration notes and compatibility tests.

## Runtime data

Ignored runtime files:

- `data/token.txt`: local bearer token.
- `data/translations.jsonl`: plaintext `/translate` cache.
- `data/runtime/`: empty Codex working directory.
- `config.ps1`: optional local configuration and secrets.

General Chat/Responses content must not be written to `translations.jsonl`.

## Changes and releases

- Never commit `data/`, `config.ps1`, `.env`, `dist/`, `node_modules/`, logs, or temp files.
- Keep `package-lock.json` synchronized and `@openai/codex` pinned to an exactly tested version.
- Update README and config examples when endpoints, setup, defaults, or environment variables change.
- Keep repository-authored work under MIT and preserve third-party licenses.
- Portable releases must contain no credentials/cache/auth data, verify the Node archive checksum, and include license texts.
- Before committing, run `npm.cmd run check`, `git diff --check`, and PowerShell syntax checks.
- For App Server or streaming changes, run live Chat, Responses, and `/translate` smoke tests when credentials are available.
