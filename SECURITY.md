# Security

## Intended deployment

Codex Translator Bridge is designed for one user on one Windows PC. It must remain bound to a loopback address and must not be exposed as a LAN, public, shared-account, or resale service.

The bridge reuses the user's local Codex authentication through the official Codex runtime. It must never read, copy, return, or log Codex authentication files or tokens.

## Local secrets and cached text

- data/token.txt is a local bearer token used only to protect the loopback HTTP endpoints.
- data/translations.jsonl can contain source text and translations in plaintext.
- config.ps1 may contain local configuration or a custom bearer token.

These paths are ignored by Git. Do not attach them to issues or support requests.

To rotate the local bearer token, stop the bridge, remove data/token.txt, and start the bridge again. Update LunaTranslator with the newly generated value.

Set CODEX_TRANSLATOR_PERSIST_CACHE=false to keep translations only in memory for the lifetime of the process. Remove data/translations.jsonl while the bridge is stopped to clear an existing persistent cache.

## Untrusted translation input

Game text, subtitles, context, glossary entries, and OpenAI-compatible messages are untrusted model input. Security-sensitive changes must preserve:

- translation-only base and developer instructions;
- disabled shell, network, MCP, plugins, apps, browser, computer-use, hooks, and approval paths;
- ephemeral read-only Codex threads;
- structured output validation;
- placeholder protection and restoration;
- bounded request, queue, batch, and timeout limits.

## Reporting

Use GitHub private vulnerability reporting when it is available for this repository. For non-sensitive bugs, open a normal issue with a minimal synthetic reproduction.

Do not include Codex credentials, bearer tokens, private source text, cache contents, or full environment dumps in any report. Provide the smallest reproducible request with synthetic text and redact local paths when they identify a user.
