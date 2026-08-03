import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import type { Provider } from "@/provider/provider"
import { Config } from "../config/config"

export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  /** When the user message begins with `/<name>` matching an installed
   *  skill, the model should invoke the skill tool immediately and
   *  silently — zero text output before the tool call. */
  export function slashSkillDirective(): string[] {
    return [
      `<slash-skill-invocation>
When the user message begins with /<name> and <name> matches an available
skill:

1. Your VERY FIRST output token must be the tool call to skill({name: "<name>"}).
2. Produce ZERO text before the tool call. No "I'll load", no "Loading X",
   no "Sure, let me consult X first", no acknowledgement of any kind.
3. After the tool returns, your next user-visible message is your direct
   response to the user's actual request (which may be implicit in just
   "/<name>" — in that case ask what they want, but ONLY after the tool
   returns, never before).

FORBIDDEN outputs before the skill tool call (these are all wrong):
  ❌ "I'll load the caveman skill as requested."
  ❌ "Let me consult the caveman skill first."
  ❌ "Loading caveman..."
  ❌ "Sure, I'll use that skill."

CORRECT pattern:
  [no text]
  → skill({name: "caveman"}) tool call
  → tool result lands
  → [now you may speak, using the loaded skill's voice]

If <name> is NOT a known skill, treat the / as literal text and respond
normally.
</slash-skill-invocation>`,
    ]
  }

  export async function planModeInstructions(): Promise<string[]> {
    const config = await Config.get()
    if (config.experimental?.plan_mode !== true) return []
    return [
      `<plan-mode>
Plan Mode is enabled. You have a PlanWrite tool instead of TodoWrite.
Use PlanWrite to structure your work as a visible plan in the user's sidebar.
The plan panel shows items in real-time. Treat each item as a step, not a task.
Update status as you work: pending -> in_progress -> completed.
Keep only one item in_progress at a time.
</plan-mode>`,
    ]
  }

  export async function databaseModeInstructions(): Promise<string[]> {
    const { DatabaseMode } = await import("../storage/db/mode")
    if (!DatabaseMode.enabled()) return []
    return [
      `<knowledge-graph-mode>
The local knowledge graph is active (mode: ${DatabaseMode.get()}).

For a single lookup use \`graph_search\` (nodes plus full-text over past message content) or \`graph_neighbors\` (one hop).

For a question needing more than one hop, use the think-on-graph skill: \`graph_link\` to find starting entities, then \`graph_explore_relations\` -> prune -> \`graph_expand\`, repeating, then \`graph_evidence\` to cite. You do the pruning; following every relation just returns noise. \`graph_reason\` runs the same loop in one call at the cost of extra model calls per hop.

Record what you learn with \`kb_entity\` (accessions are verified against the source database) and \`kb_assert\` (requires a source and a confidence). Both land unreviewed until audited, so when you cite graph results, distinguish observed facts from agent assertions.

Every \`science_search\` hit is recorded into the graph automatically — you do not need to do anything for that.

The Obsidian vault is NOT synced automatically. \`griffin db export-obsidian\` writes it, and \`griffin db rebuild\` refreshes it if it already exists. Only mention it if the user asks to see the graph.
</knowledge-graph-mode>`,
    ]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<files>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 200,
              })
            : ""
        }`,
        `</files>`,
      ].join("\n"),
    ]
  }
}
