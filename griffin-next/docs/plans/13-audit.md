# Audit — Think-on-Graph, Obsidian sync, KG coverage, db modes

Second audit pass, covering the components added outside the workstream-12 plan:
the ToG skill, the Obsidian visual graph, knowledge-graph coverage of prompts
and responses, and the `off`/`shadow`/`primary` rollout modes.

**Method:** claims verified by running the code, not by reading it. Where a
defect is asserted below, it was reproduced.

**Baseline:** `bun test` — 1239 pass / 38 fail / 1290 tests. The 38 are
byte-for-byte the pre-existing Windows path/symlink/unicode set; `comm` against
the captured baseline shows zero new failures. `bun run typecheck` clean.

---

## Verdict

| Area | State |
| --- | --- |
| SQLite graph (queries / application) | **Solid.** Schema, trust columns, traversal, caps, tests. |
| ToG reasoning layer | **Solid.** Primitives + orchestrator, 65 tests, defends against a model in the loop. |
| KG over prompts & responses | **Works, with one gap** — snippet in the label, full text only via FTS. |
| ToG skill | **Works in dev, absent from a built binary.** Three drifted copies. |
| Obsidian graph | **Not production-ready.** Silent data loss, a crash on ordinary input, zero tests, and it is *not* auto-synced. |
| `off` / `shadow` | **Solid.** |
| `primary` | **Dangerous.** Silent partial data loss with no guard. |

Two findings are severe enough to fix before anyone else uses this: **O1** and
**M1**.

---

## Obsidian graph

### O1 — Filename collisions silently drop nodes and edges. **Severe**

`obsidian.ts:35` derives the filename from `node.label`. Labels are not unique:
`derive.ts` labels every tool run `Run <tool>`, so a session with 50 `read`
calls produces **one** `Run read.md`, and each write overwrites the last.

Reproduced — 5 nodes, 2 edges in, 4 files out:

```
nodes in db   : 5
reported      : 5      <-- exportedNodes counts the map, not files written
files on disk : 4
```

`Run read.md` ends up holding one arbitrary run's connections; the other run's
`produced` edge to `a.txt` is gone from the vault entirely. The return value
reports 5 exported, so nothing surfaces the loss.

Fix: key the filename on node id (or `label — id-suffix`), and count files
actually written.

### O2 — One long label aborts the entire export. **Severe**

No length clamp before `writeFileSync`. A 300-character label throws `ENOENT`
and the whole vault export dies partway through, leaving it half-written:

```
ENOENT: no such file or directory, open '...\vault\xxxxx….md'
```

This is not exotic. The vault in `griffin-next/obsidian_kg/` already contains
`A Systematic p53 Mutation Library Links Differential Functional Impact to
Cancer Mutation Pattern and Evolutionary Conservation..md` at ~130 characters —
a longer PubMed title crosses the limit. Clamp to ~180 chars plus a hash
suffix.

### O3 — Not actually auto-synced

`exportVault` has exactly three callers: the CLI command, the server route, and
nothing else. There is no hook on write, on turn end, or on `db rebuild`. The
"auto-sync" in the skill and the system prompt is an *instruction to the model*
to shell out to `griffin db export-obsidian` — which works only if the model
remembers and has bash permission.

Either wire it (post-turn hook, or an option on `db rebuild`) or stop
describing it as automatic in `SKILL.md:36` and `system.ts:87`.

### O4 — Stale notes are never removed

The export writes files but never deletes. A node dropped from the graph leaves
its `.md` behind forever, and Obsidian keeps rendering it with edges to nodes
that no longer exist. The vault monotonically diverges from the database.

### O5 — Windows-hostile and Obsidian-hostile names unhandled

`replace(/[/\\?%*:|"<>]/g, "_")` misses:
- reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…) — unwriteable on Windows
- a leading `.` — hidden file
- a label containing `]]`, which breaks the `[[wikilink]]` it is embedded in

### O6 — Zero tests

`grep -rln "ObsidianExporter" test/` → nothing. Every defect above would have
been caught by one round-trip test. This is the only module in the datastore
with no coverage at all.

### O7 — `scripts/gen_obsidian.ts` is a second, drifted implementation

It duplicates `exportVault` with the same collision bug, hardcodes the output
directory, and uses `review_state != "rejected"` — double quotes, which SQLite
parses as an *identifier* first and only falls back to a string literal by
legacy quirk. Delete it, or make it call `ObsidianExporter`.

### O8 — Message text is exported verbatim into plaintext notes

`obsidian.ts:56-73` inlines full message text. Reasonable for a local vault,
but vaults get synced to iCloud/Dropbox/Git. Worth a flag (`--include-text`,
default off) rather than being unconditional.

---

## Database modes

### M1 — `primary` silently hides data when the DB is not fully backfilled. **Severe**

There is no guard anywhere tying `primary` to a completed backfill. Flipping
`experimental.db` to `primary` immediately routes `read`, `update`, and `list`
to SQL — whatever is or is not in it.

Measured on this machine, right now:

```
JSON project files on disk : 15
rows in project table      :  8
=> primary mode hides        7 projects, with no error
```

`list(["project"])` returns 8 entries instead of 15. Not an exception, not a
warning — a shorter list. To a user, half their projects have vanished.

The JSON is still on disk (primary keeps writing it), so this is recoverable by
setting the mode back. But the failure presents as data loss, on the single
most consequential config flip in the design.

Fix, in order of value:
1. On first `primary` use, compare JSON key count to row count per namespace and
   **refuse to start** with "run `griffin db backfill` first" if they disagree.
2. Have `db status` show a readiness line: *"primary: NOT READY — 7 of 15
   projects unprojected."*
3. Longer term, `db verify` clean should be a precondition the code checks, not
   a step in a document.

### M2 — Mode transitions are undocumented as a procedure

The correct sequence is `off` → `shadow` → *run backfill* → *run verify* →
`primary`. That is stated in the plan prose but nothing in the product enforces
or even prints it. Related to M1; fixing M1 largely covers it.

### What is solid

`off` genuinely restores prior behaviour (projection short-circuits, graph and
KB tools are not registered — asserted by `tool-registration.test.ts`).
`shadow` never throws on projection failure. Mode resolution avoids the
`Config → Instance → Project → Storage` cycle. `Storage.update` reads from the
authoritative store. WAL setup is cross-process safe with a regression test
that genuinely fails when the fix is reverted.

---

## Think-on-Graph skill

### S1 — Absent from a compiled binary

`skill.ts:22-30`: the compiled binary ships no skills and resolves them from
`SYSTEM_SKILLS` (embedded) or the API index. `think-on-graph` is in neither, so
it resolves from the filesystem glob in `bun run dev` and **disappears in a
built install**.

Fix: add it to `SYSTEM_SKILLS` with embedded content (`test/skill/system-skills.test.ts`
already enforces sync for the existing entry), or publish it to the skill index.

### S2 — Three different versions across four copies

```
6d56b282  1868  .agents/skills/think-on-graph
07f6fe3c  1962  .claude/skills/think-on-graph
07f6fe3c  1962  .griffin/skills/think-on-graph
fac99fd1  1973  backend/cli/skills/research/think-on-graph
```

Already drifted. Pick `backend/cli/skills/research/` as the source of truth and
make the others generated or symlinked.

### S3 — The skill instructs the agent to call things that partly do not apply

`SKILL.md:24` lists `supports` as an explorable relation; nothing emits
`supports` edges yet. `SKILL.md:36` says the export makes entities render
"instantly" — see O3. Minor, but the skill is the agent's contract and a wrong
contract produces wasted tool calls.

### What is solid

The workflow is well-shaped and matches the implemented primitives: link →
explore → prune → expand → assert → evidence. The system-prompt injection
(`system.ts:74-89`) correctly gates on `DatabaseMode.enabled()` so nothing
leaks into `off` mode.

---

## Knowledge graph over prompts and responses

### Works

Every user and assistant message is a node, and `derive.ts:64-85` now puts the
first 60 characters of message text into the label, so the graph reads as
content rather than opaque ids. Full text is searchable via FTS5
(`graph_search` with `include_content`). Tool runs and file artifacts are nodes.
`mentions` edges bridge messages to entities and sources.

### K1 — Reasoning parts are not indexed

`projection.ts` indexes `text` and `reasoning` parts for FTS but the message
node label only samples `type = 'text'`. An assistant turn whose visible output
is short but whose reasoning is substantial gets an uninformative label.

### K2 — Snippet truncation is byte-naive

`.slice(0, 60)` can split a multi-byte character or an emoji sequence. Cosmetic,
but it lands in the graph label and the Obsidian filename.

### K3 — The graph is stale until `db rebuild`

Derivation is not on the write path — noted in the workstream-12 audit, still
true. Combined with O3, a user's Obsidian vault is two manual steps behind
reality.

---

## Recommended order

1. **M1** — guard `primary` on backfill completeness. Highest blast radius.
2. **O1 + O2** — filename keying and length clamp, with a round-trip test (O6).
   Currently the vault silently misrepresents the graph.
3. **S1** — embed the skill, or it does not exist in a real install.
4. **O3** — wire auto-sync, or correct the two places that claim it exists.
5. **O4, O7, S2** — stale notes, duplicate exporter, skill copies.
6. **K1, K2, O5, O8** — polish.

---

## Resolution

All findings addressed, in the order above.

| # | Resolution |
| --- | --- |
| **M1** | New `storage/db/readiness.ts`. Before any `primary` read, per-namespace JSON counts are compared to row counts; a shortfall **refuses the read** with the counts, the remedy (`griffin db backfill`), an assurance that nothing is lost, and `GRIFFIN_DB_SKIP_READINESS=1` as an escape hatch. Checked once per process, memoized on the promise so concurrent first reads share one scan, and *not* memoized on failure so a transient error is retryable. `db status` now prints `primary NOT READY — 5 namespace(s) unprojected` with per-namespace counts. Rows exceeding files does not block — that is `db verify`'s business and blocking on it would make the gate permanently red. |
| **O1** | Note filenames are keyed on node **id**, not label: `"<label> (<hash6>)"`. Label still leads so the vault stays readable; the suffix only disambiguates. `ExportResult` now reports `written` — files actually written — instead of the size of a map. |
| **O2** | Stem clamped to 120 code points, so `name + ".md"` stays well under NAME_MAX. Truncation is by code point, never splitting a surrogate pair. |
| **O3** | `syncIfPresent()` refreshes a vault **that already exists** and does nothing otherwise, called from `db rebuild` (`--obsidian`, default on). A vault is never conjured for someone who did not ask. The system prompt and `SKILL.md` were rewritten to say plainly that sync is not automatic. |
| **O4** | Pruning added. Only files carrying a `<!-- griffin-kg -->` marker are eligible — an Obsidian vault is user-editable, and deleting a hand-written note because it sits in the export directory would be unforgivable. Tested. |
| **O5** | Windows reserved device names neutralised; leading and trailing dots stripped; `#^[]` added to the character filter (Obsidian-hostile, not just Windows-hostile); `]]` in a label can no longer break the wikilink embedding it. |
| **O6** | `test/storage/db/obsidian.test.ts` — 26 tests where there were none. Every defect above is pinned, including a link-integrity check that every `[[link]]` resolves to a file that exists. |
| **O7** | `scripts/gen_obsidian.ts` is now a thin wrapper over `ObsidianExporter`, so the entry point survives but the second implementation does not. `scripts/gen_graph.ts` is a distinct 3D viewer, kept — its `!= "rejected"` double-quoted literal was corrected (SQLite resolves double quotes as an identifier first) and merged nodes are now excluded. |
| **O8** | `--include-text` is off by default. **The audit under-stated this one:** the test proved `includeText: false` still leaked prompt text, because message *labels* carry a 60-character snippet that lands in the heading and the filename. Added `--redact`, which titles message notes `role id` so no wording reaches the body, heading, or filename. The flag's real contract is now pinned by a test rather than assumed. |
| **S1** | `think-on-graph` added to `SYSTEM_SKILLS` with embedded content, so it survives into a compiled binary. |
| **S2** | All five copies (`.agents`, `.claude`, `.griffin`, `backend/cli/skills`, embedded) synced from the canonical `backend/cli/skills/research/`. |
| **S3** | `SKILL.md` rewritten: only the five relations actually emitted are documented (`supports` and `same-as` were listed but nothing writes them), the "renders instantly" claim removed, the new primitives and `graph_reason` documented with their cost, and pruning framed as the method rather than a step. |
| **K1** | Message labels now fall back to `reasoning` when a turn has no visible text, prefixed `(reasoning)` so a label never reads as something the user was shown. |
| **K2** | Snippet truncation is by code point with an ellipsis. Verified: 100 emoji in, 60 clean code points out, no replacement characters. |

### Test coverage added

`obsidian.test.ts` (26) and `readiness.test.ts` (12), plus the `system/*.txt`
completeness guard.

| Check | After |
| --- | --- |
| `bun run typecheck` | ✅ clean |
| `bun test` (full) | **1289 pass / 38 fail** / 1340 tests |
| Failures attributable to this work | **0** — `comm` against the captured baseline shows zero new |
| `bun test test/storage/ test/skill/` | **211 pass / 0 fail**, 24 files |
| Real data dir: `db backfill` → `db status` | 522 records, 0 errors, `primary_ready: true` |
| Real graph → Obsidian | 55 nodes → 55 notes, no collisions |

### The largest gap, found by asking whether the skill actually works

**The agent could create nodes but not edges, so everything it recorded was an
island.** The only edge it could author was `claim --derived-from--> source`,
emitted implicitly by `kb_assert`. There was no way to attach a claim to the
entities it concerns, or to relate two entities.

Reproduced: record TP53, record a paper, assert a claim about TP53 citing that
paper — then traverse from TP53.

```
expand(TP53, out)  -> []
expand(TP53, in)   -> []
expand(TP53, both) -> []
relations leaving TP53: []
```

The claim about TP53 was not reachable from TP53. This defeats Think-on-Graph
for agent-authored knowledge entirely, because traversal *is* the method:
knowledge that traversal cannot reach is, for every question anyone actually
asks, the same as knowledge that was never stored. It also explains why the KB
half looked so sparse — it was not just under-populated, it was disconnected.

**Fixed** with `kb_link`, plus an `about` parameter on `kb_assert` so the common
case needs one call rather than three.

The relation set stays **closed**, and deliberately narrower than the catalogue:

| Agent may author | Agent may not |
| --- | --- |
| `mentions`, `derived-from`, `supports`, `refutes`, `same-as` | `part-of`, `produced`, `consumed` |

The excluded three are system-observed lineage. A model asserting them would be
fabricating provenance, which is the single thing the trust columns exist to
prevent. For a relationship the five cannot express, the escape hatch is still a
claim — it carries a source, a confidence and a review state, whereas an edge is
structural and implicitly trusted.

Guarded: both endpoints must exist (a dangling edge is refused with the missing
id named, rather than surfacing a raw FK error); self-links refused; edges
marked `origin='agent'`; re-linking is idempotent; and linking does **not**
launder trust — an unreviewed claim stays out of default scope even once
connected.

Verified end to end. Starting from TP53, hop 1 reaches the claim, hop 2 reaches
both the source paper and vemurafenib — a compound TP53 was never directly
linked to:

```
seeds : TP53
hop 1: mentions -> TP53 status modulates vemurafenib response
hop 2: mentions, derived-from -> p53 and drug response | vemurafenib
```

`kb-authoring.test.ts` (10 tests) pins the island case so it cannot return.

### A further defect found while fixing M1

**Orphaned records would have made readiness permanently unreachable.** The
first version of the gate compared raw file counts, and the full suite caught
it: `part: 4 on disk, 0 in the database`.

Those parts were orphans — their parent message no longer existed. Because
`part` references `message` and `message` references `session` with foreign
keys on, an orphan is **unprojectable by construction**: backfill logs it and
moves on, forever. Counting it as "missing" turns the guard from a gate into a
wall, and `primary` could never be reached.

This is not a test artifact. `Session.remove` is a three-level delete loop
wrapped in a single try/catch that only `log.error`s, so a partial delete
leaving orphan parts is a real outcome.

`Readiness.check` now classifies by projectability. Keys are already
`[kind, parent, id]`, so the parent is in hand with no extra filesystem work: a
message whose session is absent, or a part whose message is absent, is counted
as `orphaned` rather than `missing`. Orphans are named in the explanation so
they stay visible — they are a genuine integrity problem for `db verify` to
report — but they no longer block every read.

Verified end to end on the real data dir: `db backfill` → 522 records, 0
errors → `db status` reports `primary_ready: true`.

### One test changed rather than bypassed

`parity.test.ts` started failing once the readiness guard landed — it writes in
`off` (no projection) then reads in `primary`. That is the guard working. It now
runs `Backfill.run()` before the `primary` iteration, which is the required
sequence anyway (`shadow → backfill → verify → primary`), so the guard stays
live in that test instead of being switched off with the override.
