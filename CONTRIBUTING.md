# Contributing

Thank you for helping improve Codex Bridge.

## Before opening an issue

- Search existing issues first.
- Reproduce the problem with the latest committed version.
- Use synthetic request and translation text whenever possible.
- Never attach `data/`, `config.ps1`, environment dumps, Codex authentication files, bearer tokens, private game text, or translation cache contents.
- Redact Windows user names and other identifying parts of local paths.

Security reports should follow [SECURITY.md](SECURITY.md). Do not place secrets or private source text in a public issue.

## Development

Use Node.js 18 or newer on Windows PowerShell:

```powershell
npm.cmd ci
npm.cmd run check
```

The automated test suite uses fake structured runners and must not require a Codex login or network access. Changes to the App Server integration should also receive a local live smoke test when credentials are available.

Keep the safety invariants in [AGENTS.md](AGENTS.md): loopback-only HTTP, bearer authentication by default, ephemeral read-only Codex threads, disabled tools and network access, bounded inputs, structured output, and placeholder validation.

## Pull requests

- Keep each pull request focused.
- Explain the user-visible behavior and security impact.
- Add or update tests for changed routes, model selection, SSE event order, cancellation, cache behavior, batching, input validation, or placeholder handling.
- Update README and configuration examples when setup, endpoints, or defaults change.
- Run `npm.cmd run check` and `git diff --check` before submitting.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
