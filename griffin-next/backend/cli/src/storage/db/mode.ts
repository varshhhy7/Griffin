import path from "path"
import { readFileSync } from "fs"
import { Global } from "../../global"
import { lazy } from "../../util/lazy"

/**
 * Resolves the `experimental.db` rollout mode.
 *
 * Deliberately does NOT import Config. `config/config.ts` imports `Instance`,
 * which reaches `Project`, which imports `Storage` — so a `Storage -> Config`
 * edge would close a cycle. Config still *declares* the flag (the top-level
 * schema is `.strict()`, so an undeclared `experimental.db` is a validation
 * error); this module only *reads* it, off the same file Config would.
 *
 * Global rather than project-scoped, which is also the correct semantics:
 * there is one database per data dir, not one per project.
 */
export namespace DatabaseMode {
  export type Mode = "off" | "shadow" | "primary"

  const MODES: Mode[] = ["off", "shadow", "primary"]

  /** Config files Config itself reads, in the order it prefers them. */
  const FILES = ["griffin.jsonc", "griffin.json"]

  function fromEnv(): Mode | undefined {
    const raw = process.env["GRIFFIN_DB"]?.trim().toLowerCase()
    return MODES.find((x) => x === raw)
  }

  function fromConfig(): Mode | undefined {
    for (const file of FILES) {
      try {
        const text = readFileSync(path.join(Global.Path.config, file), "utf8")
        // Tolerate JSONC line comments; a malformed config is Config's problem
        // to report, not ours, so anything unparseable just falls through.
        const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""))
        const raw = parsed?.experimental?.db
        const found = MODES.find((x) => x === raw)
        if (found) return found
      } catch {}
    }
    return undefined
  }

  const state = lazy((): Mode => fromEnv() ?? fromConfig() ?? "off")

  /** The active mode. Memoized — the flag cannot change mid-process. */
  export function get(): Mode {
    return state()
  }

  /** True when SQLite should be written at all. */
  export function enabled(): boolean {
    return state() !== "off"
  }

  /** True when SQLite is the read path and projection failures must propagate. */
  export function primary(): boolean {
    return state() === "primary"
  }

  /** Tests only — the mode is otherwise fixed for the process lifetime. */
  export function reset(): void {
    state.reset()
  }
}
