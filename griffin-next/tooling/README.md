# Workspace tooling

Tooling is kept separate from product runtime code.

- `sdk/js/` — generated TypeScript SDK from the backend API contract.
- `plugin/` — `@griffin/plugin` runtime and extension surface.
- `launcher/` — the `npx griffin` installer and platform binary selector.
- `repo/` — release, changelog, publish, and code-generation helpers.
- `script/` — build helpers used across packages.
- `util/` — shared TypeScript utilities.
- `patches/` — dependency patches applied during installation.

Change generators and source contracts first; do not hand-edit generated SDK
output unless the generator explicitly produces that file.
