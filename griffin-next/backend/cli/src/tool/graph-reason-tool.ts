import z from "zod"
import { Tool } from "./tool"
import { DatabaseClient } from "../storage/db/client"
import { GraphReason } from "../storage/db/graph/reason"
import { LLM } from "../session/llm"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { MessageV2 } from "../session/message-v2"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.graph_reason" })

/**
 * One-shot Think-on-Graph.
 *
 * The primitives in `graph-reason.ts` let the calling model run the beam
 * search itself. This runs the same loop server-side, pruning with a small
 * model, for callers that want a single call. It costs 2 model calls per hop,
 * which is why depth defaults to 2.
 *
 * It deliberately returns EVIDENCE, not an answer. The calling model already
 * has the question and the full conversation; making it write the answer from
 * cited triples keeps the reasoning in one place and avoids paying twice for
 * generation.
 */

/** Most recent user message in the session — supplies system prompt and variant. */
async function currentUser(sessionID: string): Promise<MessageV2.User | undefined> {
  for await (const msg of MessageV2.stream(sessionID)) {
    if (msg.info.role === "user") return msg.info as MessageV2.User
  }
  return undefined
}

/** Ask a small model for a JSON answer, tolerating prose around it. */
async function ask<T>(
  input: { sessionID: string; user: MessageV2.User; abort: AbortSignal; prompt: string; fallback: T },
): Promise<T> {
  try {
    const agent = await Agent.get("title")
    if (!agent) return input.fallback
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : ((await Provider.getSmallModel(input.user.model.providerID)) ??
        (await Provider.getModel(input.user.model.providerID, input.user.model.modelID)))

    const stream = await LLM.stream({
      agent,
      user: input.user,
      tools: {},
      model,
      small: true,
      messages: [{ role: "user" as const, content: input.prompt }],
      abort: input.abort,
      sessionID: input.sessionID,
      system: ["You answer with JSON only. No prose, no code fences."],
      retries: 2,
    })

    const text = await stream.text
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return input.fallback
    return JSON.parse(match[0]) as T
  } catch (e) {
    // A pruning failure must degrade the search, never abort it — a partial
    // traversal is still useful, an exception is not.
    log.warn("pruner call failed; falling back", { error: e })
    return input.fallback
  }
}

export const GraphReasonTool = Tool.define("graph_reason", {
  description: [
    "Answer a question by reasoning over the knowledge graph, one hop at a time.",
    "Links the question to entities, then repeatedly explores relations, prunes them, and expands —",
    "returning the evidence paths it found. Use this for multi-hop questions",
    "('which papers back the claim about TP53 that came out of last week's run?').",
    "Returns EVIDENCE, not a conclusion: read the triples and write the answer yourself,",
    "distinguishing observed facts from agent assertions.",
    "For single-hop lookups prefer graph_search or graph_neighbors — this is more expensive.",
  ].join("\n"),
  parameters: z.object({
    question: z.string().describe("The question to reason about"),
    terms: z
      .array(z.string())
      .min(1)
      .max(10)
      .describe("Topic entities from the question: gene symbols, accessions, file paths, paper titles"),
    depth: z.number().optional().default(2).describe("Hops to traverse (1-5). Each hop costs 2 model calls."),
    width: z.number().optional().default(5).describe("Beam width — nodes kept per hop (1-16)"),
    include_unreviewed: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include unreviewed agent-asserted nodes. Default false."),
  }),
  async execute(params, ctx) {
    const handle = DatabaseClient.reader()
    const user = await currentUser(ctx.sessionID)

    // Without a user message there is no model context to prune with; run the
    // traversal unpruned rather than failing outright.
    const pruners: GraphReason.Pruners = !user
      ? GraphReason.passthroughPruners
      : {
          relations: async ({ question, hop, options }) => {
            const listed = options
              .map((o) => `- ${o.relation} (${o.direction}, reaches ${o.reaches} ${o.kinds.join("/")} node(s))`)
              .join("\n")
            const res = await ask<{ relations: string[] }>({
              sessionID: ctx.sessionID,
              user,
              abort: ctx.abort,
              fallback: { relations: [] },
              prompt: [
                `Question: ${question}`,
                `You are at hop ${hop} of a knowledge-graph search.`,
                `Available relations from the current frontier:`,
                listed,
                ``,
                `Which relations could lead toward answering the question?`,
                `Reply as {"relations": ["name", ...]}. Choose few. Empty means "all".`,
              ].join("\n"),
            })
            return Array.isArray(res.relations) ? res.relations : []
          },

          entities: async ({ question, hop, candidates, width }) => {
            const listed = candidates
              .map(
                (c) =>
                  `- ${c.id} [${c.kind}${c.subtype ? "/" + c.subtype : ""}] ${c.label}` +
                  ` (${c.origin === "system" ? "observed" : `${c.origin}/${c.review_state}`})`,
              )
              .join("\n")
            const res = await ask<{ keep: string[]; sufficient: boolean }>({
              sessionID: ctx.sessionID,
              user,
              abort: ctx.abort,
              fallback: { keep: [], sufficient: false },
              prompt: [
                `Question: ${question}`,
                `Hop ${hop} reached these nodes:`,
                listed,
                ``,
                `Keep at most ${width} that are most likely to lead to the answer.`,
                `Set "sufficient" to true only if these already answer the question.`,
                `Reply as {"keep": ["id", ...], "sufficient": false}.`,
              ].join("\n"),
            })
            return {
              keep: Array.isArray(res.keep) ? res.keep : [],
              sufficient: res.sufficient === true,
            }
          },
        }

    const result = await GraphReason.run(
      handle,
      {
        question: params.question,
        terms: params.terms,
        depth: params.depth,
        width: params.width,
        includeUnreviewed: params.include_unreviewed,
      },
      pruners,
    )

    if (result.seeds.length === 0) {
      return {
        title: "Graph reason",
        output: [
          `Could not link any of [${params.terms.join(", ")}] to the knowledge graph.`,
          `The KB may not cover this yet — try graph_search to look in message content instead.`,
        ].join("\n"),
        // Same shape as the success branch — a union of metadata shapes is
        // not assignable to Tool.define's handler type.
        metadata: { seeds: 0, hops: 0, visited: 0, triples: 0, stopped: result.stopped },
      }
    }

    const sections: string[] = [
      `**Seeds**: ${result.seeds.map((s) => `\`${s.id}\` ${s.label}`).join(", ")}`,
      "",
    ]

    for (const hop of result.hops) {
      sections.push(
        `**Hop ${hop.hop}** — followed ${hop.relationsChosen.join(", ") || "(none)"}` +
          ` of ${hop.relationsOffered.length} offered; reached ${hop.reached}, kept ${hop.kept.length}`,
      )
      for (const k of hop.kept) sections.push(`  - \`${k.id}\` [${k.kind}] ${k.label}`)
    }

    sections.push("", `**Evidence** (${result.triples.length} triples):`)
    if (result.triples.length === 0) {
      sections.push("  (none — the visited nodes are not connected to each other)")
    }
    for (const t of result.triples) {
      const trust =
        t.origin === "system"
          ? "observed"
          : `${t.origin}${t.confidence !== null && t.confidence !== undefined ? ` @${t.confidence.toFixed(2)}` : ""}`
      sections.push(`  - (${t.subject}) --${t.relation}--> (${t.object})  [${trust}]`)
    }

    sections.push(
      "",
      result.stopped === "sufficient"
        ? "_Search stopped early: the evidence was judged sufficient._"
        : result.stopped === "exhausted"
          ? "_Search stopped: no further relations to follow._"
          : "_Search stopped at the depth limit; there may be more._",
      "Answer from the triples above, and mark agent-asserted claims as claims rather than facts.",
    )

    return {
      title: `Graph reason: ${params.question.slice(0, 60)}`,
      output: sections.join("\n"),
      metadata: {
        seeds: result.seeds.length,
        hops: result.hops.length,
        visited: result.visited.length,
        triples: result.triples.length,
        stopped: result.stopped,
      },
    }
  },
})
