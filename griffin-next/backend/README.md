# Workspace backend

The backend package is the Bun/TypeScript CLI and local server. It is the
runtime behind the browser workspace.

- `cli/src/index.ts` — process entry point and command registration.
- `cli/src/cli/` — user-facing command implementations.
- `cli/src/server/` — local Hono server and API/SSE boundary.
- `cli/src/session/` — agent loop, message processing, provenance, and review gates.
- `cli/src/agent/` — agent registry and prompt definitions.
- `cli/src/tool/` — shell, file, LSP, MCP, and graph tools.
- `cli/src/science/` — scientific connectors and governed research runs.
- `cli/src/provider/` — model provider routing and catalog handling.
- `cli/src/storage/` — sessions, SQLite datastore, migrations, and projections.
- `cli/test/` — backend tests, fixtures, and snapshots.

Read [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the runtime diagram. When
the server contract changes, regenerate `tooling/sdk/js/` using the repository
generator and run the backend typecheck plus tests.
