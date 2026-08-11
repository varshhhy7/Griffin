# Workspace frontend

The frontend is split by deployment and reuse boundary.

- `workspace/` — the main SolidJS application served by the local CLI.
- `ui/` — shared components, styles, themes, icons, and interaction helpers.
- `docs/` — documentation and session-share site.
- `landing/` — public marketing site at `griffin.sh`.

For a screen change, start in `workspace/src/`. Move a component into `ui/src/`
only when it is genuinely shared by more than one frontend package. Keep API
types and network behavior aligned with the generated SDK rather than adding
package-local copies.
