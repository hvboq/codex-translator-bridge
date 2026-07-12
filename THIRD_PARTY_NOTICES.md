# Third-party notices

Codex Bridge's repository-authored source code and documentation are licensed under the root [MIT License](LICENSE).

Installing dependencies with `npm ci` downloads third-party packages that remain under their own licenses. They are not relicensed by this repository. Direct dependencies currently include:

| Package | Purpose | License |
|---|---|---|
| `@openai/codex` | Codex runtime and App Server launcher | Apache-2.0 |
| `@types/node` | Node.js TypeScript declarations | MIT |
| `tsx` | TypeScript development/test runner | MIT |
| `typescript` | TypeScript compiler | Apache-2.0 |

See each installed package and `package-lock.json` for exact versions and transitive dependency information.

The Windows portable release also bundles the matching official Node.js x64 runtime and the platform-specific Codex executable. Their full license texts are included in the release under `licenses/`.
