# Security

## Intended deployment

Codex Bridge is designed for one user on one computer. It must remain bound to a loopback address and must not be exposed as a LAN, public, shared-account, resale, or hosted proxy service.

The bridge uses the user's local authentication through the official Codex runtime. It must never read, copy, return, bundle, or log Codex authentication files or tokens.

General requests and translation source text are sent to OpenAI's Codex service for model processing. Do not submit content that your account or organization is not permitted to send to that service.

## Local secrets and cached text

- `data/token.txt` is the local bearer token protecting HTTP endpoints.
- `data/translations.jsonl` can contain `/translate` source text and translations in plaintext.
- `config.ps1` can contain local configuration or a custom bearer token.

These paths are ignored by Git. Never attach them to issues or support requests.

To rotate the local key, stop the bridge, remove `data/token.txt`, start again, and update every local client. Set `CODEX_BRIDGE_PERSIST_CACHE=false` to disable persistent translation caching. Remove `data/translations.jsonl` while stopped to clear it.

General Chat Completions and Responses content is not written to the translation cache.

## Untrusted input

All messages, instructions, translation text, context, glossary values, metadata, and content parts are untrusted model input. Security-sensitive changes must preserve:

- sanitized reconstruction of text-only history items;
- explicit rejection of tool, function, image, audio, file, stateful, and stored-response requests;
- separate general and translation instruction profiles;
- disabled shell, network, MCP, plugins, apps, browser/computer use, memory, hooks, and approvals;
- ephemeral read-only Codex threads;
- final-answer-only streaming;
- translation structured-output and placeholder validation;
- bounded request, queue, concurrency, batch, and timeout limits;
- turn interruption and unsubscribe cleanup after aborts and failures.

## Local API authentication

The local API Key is independent from the user's Codex login. It is generated separately on every installation unless overridden with `CODEX_BRIDGE_TOKEN`. Do not paste `Bearer ` into an application's API Key field unless that application explicitly requires a complete Authorization header.

`CODEX_BRIDGE_NO_AUTH=true` is intended only for incompatible localhost clients. It does not permit a non-loopback bind and should not be combined with a browser-accessible permissive CORS proxy.

## Reporting

Use GitHub private vulnerability reporting when available. For non-sensitive bugs, open a normal issue with a minimal synthetic reproduction.

Do not include Codex credentials, bearer tokens, private request text, cache contents, full environment dumps, or identifying local paths in reports.
