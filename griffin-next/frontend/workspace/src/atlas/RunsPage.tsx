import { For, Show, createEffect, createMemo, createSignal, onMount, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { IconActivity, IconAlertCircle, IconCheckCircle, IconFlask, IconPlus, IconRefresh, IconX } from "@/atlas/shared/Icon"

type Check = { id: string; label: string; status: "pass" | "warning" | "fail"; message: string }
type Run = {
  id: string
  workflow: { id: string; version: string; name: string }
  status: "blocked" | "awaiting_approval" | "ready" | "running" | "completed" | "failed" | "cancelled"
  progress: { current: number; total: number; step: string }
  inputs: { key: string; path: string; checksum: string; size: number }[]
  parameters: Record<string, unknown>
  plan: string[]
  checks: Check[]
  logs: { time: number; level: "info" | "warning" | "error"; message: string }[]
  outputs: { key: string; path: string; kind: string }[]
  warnings: string[]
  approvals: { time: number; decision: "approved" | "rejected"; note?: string }[]
  time: { created: number; updated: number; started?: number; completed?: number }
}
type Preview = Pick<Run, "workflow" | "inputs" | "parameters" | "plan" | "checks"> & { valid: boolean }

const STATUS_LABEL: Record<Run["status"], string> = {
  blocked: "Blocked",
  awaiting_approval: "Awaiting approval",
  ready: "Ready",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
}

export default function RunsPage(): JSX.Element {
  const sdk = useSDK()
  const platform = usePlatform()
  const doFetch = platform.fetch ?? fetch
  const [runs, setRuns] = createSignal<Run[]>([])
  const [selectedID, setSelectedID] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [launching, setLaunching] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  const endpoint = (suffix = "") => {
    const url = new URL(`${sdk.url}/research-runs${suffix}`)
    url.searchParams.set("directory", sdk.directory)
    return url.toString()
  }

  async function request<T>(suffix = "", init?: RequestInit) {
    const response = await doFetch(endpoint(suffix), init)
    if (!response.ok) {
      const body = await response.text()
      try {
        throw new Error(JSON.parse(body).message ?? body)
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(body || `Request failed (${response.status})`)
        throw error
      }
    }
    return (await response.json()) as T
  }

  async function load() {
    setLoading(true)
    setError(undefined)
    try {
      const next = await request<Run[]>()
      setRuns(next)
      if (!selectedID() && next[0]) setSelectedID(next[0].id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function act(run: Run, action: "approve" | "cancel" | "retry") {
    setBusy(true)
    setError(undefined)
    try {
      const updated = await request<Run>(`/${run.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: action === "approve" ? "{}" : undefined,
      })
      setRuns((items) => items.map((item) => (item.id === updated.id ? updated : item)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const selected = createMemo(() => runs().find((run) => run.id === selectedID()))
  createEffect(() => {
    if (selectedID() && !selected() && runs()[0]) setSelectedID(runs()[0].id)
  })
  onMount(() => void load())

  return (
    <div class="flex min-h-0 flex-1 flex-col bg-background-base">
      <div class="flex h-14 flex-shrink-0 items-center gap-3 border-b border-border-weak-base px-4">
        <IconActivity size={17} strokeWidth={1.6} />
        <div class="min-w-0 flex-1">
          <div class="text-14-medium text-text-strong">Scientific runs</div>
          <div class="truncate text-11-regular text-text-weak">Validated inputs, approvals, progress, outputs, and provenance</div>
        </div>
        <button type="button" class="flex size-8 items-center justify-center rounded-xs text-icon-weak-base hover:bg-surface-raised-base" title="Refresh runs" onClick={() => void load()}><IconRefresh size={13} /></button>
        <button type="button" class="flex h-8 items-center gap-2 rounded-xs bg-surface-raised-base-active px-3 text-12-medium text-text-strong hover:bg-surface-raised-base-hover" onClick={() => setLaunching(true)}><IconPlus size={12} />New run</button>
      </div>

      <Show when={error()}><div class="flex items-center gap-2 border-b border-border-weak-base bg-surface-base px-4 py-2 text-12-regular text-text-danger"><IconAlertCircle size={13} /><span class="flex-1">{error()}</span><button type="button" onClick={() => setError(undefined)}><IconX size={12} /></button></div></Show>

      <Show when={!launching()} fallback={<LaunchRun request={request} onClose={() => setLaunching(false)} onCreated={(run) => { setRuns((items) => [run, ...items]); setSelectedID(run.id); setLaunching(false) }} />}>
        <div class="flex min-h-0 flex-1">
          <aside class="flex w-[290px] flex-shrink-0 flex-col border-r border-border-weak-base bg-surface-base/30">
            <div class="border-b border-border-weak-base px-3 py-2 font-mono text-10-medium uppercase text-text-weak">Runs ({runs().length})</div>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <Show when={!loading()} fallback={<Empty text="Loading runs..." />}>
                <For each={runs()} fallback={<Empty text="No scientific runs yet." />}>
                  {(run) => <button type="button" class="block w-full border-b border-border-weak-base px-3 py-3 text-left hover:bg-surface-raised-base/50" classList={{ "bg-surface-raised-base/70": selectedID() === run.id }} onClick={() => setSelectedID(run.id)}><div class="mb-1 truncate text-12-medium text-text-strong">{run.workflow.name}</div><div class="flex items-center gap-2 text-10-regular text-text-weak"><StatusDot status={run.status} /><span>{STATUS_LABEL[run.status]}</span><span class="ml-auto">{relativeTime(run.time?.updated ?? 0)}</span></div></button>}
                </For>
              </Show>
            </div>
          </aside>
          <main class="min-w-0 flex-1 overflow-y-auto"><Show when={selected()} fallback={<Empty text="Select a run to inspect it." />}>{(run) => <RunDetail run={run()} busy={busy()} onAction={(action) => void act(run(), action)} />}</Show></main>
        </div>
      </Show>
    </div>
  )
}

function RunDetail(props: { run: Run; busy: boolean; onAction: (action: "approve" | "cancel" | "retry") => void }) {
  const status = () => props.run.status
  const progress = () => props.run.progress.total ? Math.round((props.run.progress.current / props.run.progress.total) * 100) : 0
  return <div class="mx-auto flex max-w-[980px] flex-col gap-6 px-6 py-6">
    <div class="flex items-start gap-4 border-b border-border-weak-base pb-5"><div class="flex size-9 flex-shrink-0 items-center justify-center rounded-xs border border-border-weak-base bg-surface-raised-base"><IconFlask size={18} /></div><div class="min-w-0 flex-1"><h1 class="text-18-medium text-text-strong">{props.run.workflow.name}</h1><div class="mt-1 flex flex-wrap items-center gap-3 font-mono text-10-regular text-text-weak"><span>{props.run.id}</span><span>v{props.run.workflow.version}</span><span>{props.run.time?.created ? new Date(props.run.time.created).toLocaleString() : "—"}</span></div></div><StatusBadge status={status()} /></div>
    <section><SectionTitle title="Progress" /><div class="mt-2 h-1.5 overflow-hidden rounded-xs bg-surface-raised-base"><div class="h-full bg-text-interactive-base transition-all" style={{ width: `${progress()}%` }} /></div><div class="mt-2 flex justify-between text-11-regular text-text-weak"><span>{props.run.progress.step}</span><span>{props.run.progress.current}/{props.run.progress.total} steps</span></div></section>
    <section><SectionTitle title="Input validation" /><div class="mt-2 divide-y divide-border-weak-base border-y border-border-weak-base"><For each={props.run.checks}>{(check) => <CheckRow check={check} />}</For></div></section>
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section><SectionTitle title="Inputs" /><div class="mt-2 divide-y divide-border-weak-base border-y border-border-weak-base"><For each={props.run.inputs}>{(input) => <div class="py-2.5"><div class="text-11-medium text-text-strong">{input.key.replaceAll("_", " ")}</div><div class="truncate font-mono text-10-regular text-text-weak">{input.path}</div><div class="mt-1 truncate font-mono text-9-regular text-text-weak">sha256 {input.checksum}</div></div>}</For></div></section>
      <section><SectionTitle title="Parameters" /><div class="mt-2 divide-y divide-border-weak-base border-y border-border-weak-base"><For each={Object.entries(props.run.parameters)}>{([key, value]) => <div class="flex gap-3 py-2 text-11-regular"><span class="flex-1 text-text-weak">{key}</span><span class="font-mono text-text-strong">{String(value || "-")}</span></div>}</For></div></section>
    </div>
    <section><SectionTitle title="Analysis plan" /><ol class="mt-2 divide-y divide-border-weak-base border-y border-border-weak-base"><For each={props.run.plan}>{(step, index) => <li class="flex gap-3 py-2.5 text-11-regular"><span class="w-5 font-mono text-text-weak">{index() + 1}</span><span class="text-text-base">{step}</span></li>}</For></ol></section>
    <section><SectionTitle title="Logs" /><div class="mt-2 min-h-20 border border-border-weak-base bg-surface-base/40 p-3 font-mono text-10-regular text-text-weak"><For each={props.run.logs}>{(log) => <div class="mb-1"><span class="mr-3">{new Date(log.time).toLocaleTimeString()}</span><span classList={{ "text-text-danger": log.level === "error", "text-text-warning": log.level === "warning" }}>{log.message}</span></div>}</For></div></section>
    <div class="flex flex-wrap justify-end gap-2 border-t border-border-weak-base pt-4"><Show when={status() === "awaiting_approval"}><ActionButton disabled={props.busy} onClick={() => props.onAction("approve")}>Approve plan</ActionButton></Show><Show when={["awaiting_approval", "ready", "running"].includes(status())}><ActionButton disabled={props.busy} danger onClick={() => props.onAction("cancel")}>Cancel</ActionButton></Show><Show when={["failed", "cancelled"].includes(status())}><ActionButton disabled={props.busy} onClick={() => props.onAction("retry")}>Retry</ActionButton></Show></div>
    <Show when={status() === "ready"}><div class="border-l-2 border-text-warning pl-3 text-11-regular text-text-weak">Plan approved. This run is waiting for the DESeq2 execution worker; Griffin has not generated scientific results yet.</div></Show>
  </div>
}

function LaunchRun(props: { request: <T>(suffix?: string, init?: RequestInit) => Promise<T>; onClose: () => void; onCreated: (run: Run) => void }) {
  const [form, setForm] = createSignal({ count_matrix: "", metadata: "", organism: "Human", reference: "GRCh38", sampleColumn: "sample_id", conditionColumn: "condition", control: "control", treatment: "treated", batchColumn: "", adjustedPValue: "0.05" })
  const [preview, setPreview] = createSignal<Preview>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const payload = () => ({ workflowID: "rna-seq-differential-expression", inputs: { count_matrix: form().count_matrix, metadata: form().metadata }, parameters: { organism: form().organism, reference: form().reference, sampleColumn: form().sampleColumn, conditionColumn: form().conditionColumn, control: form().control, treatment: form().treatment, batchColumn: form().batchColumn || undefined, adjustedPValue: Number(form().adjustedPValue) } })
  const update = (key: keyof ReturnType<typeof form>, value: string) => { setForm((current) => ({ ...current, [key]: value })); setPreview(undefined) }
  async function validate() { setBusy(true); setError(undefined); try { setPreview(await props.request<Preview>("/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) })) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  async function create() { setBusy(true); setError(undefined); try { props.onCreated(await props.request<Run>("", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) })) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  return <div class="min-h-0 flex-1 overflow-y-auto"><div class="mx-auto max-w-[1040px] px-6 py-6">
    <div class="mb-6 flex items-start gap-3 border-b border-border-weak-base pb-5"><IconFlask size={20} /><div class="flex-1"><h1 class="text-18-medium text-text-strong">RNA-seq differential expression</h1><p class="mt-1 text-12-regular text-text-weak">Validate the dataset and study design before creating a tracked scientific run.</p></div><button type="button" class="flex size-8 items-center justify-center rounded-xs hover:bg-surface-raised-base" onClick={props.onClose}><IconX size={14} /></button></div>
    <Show when={error()}><div class="mb-4 border-l-2 border-text-danger pl-3 text-12-regular text-text-danger">{error()}</div></Show>
    <div class="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.85fr)]"><div class="flex flex-col gap-5">
      <Field label="Count matrix" value={form().count_matrix} placeholder="data/counts.csv" onInput={(value) => update("count_matrix", value)} /><Field label="Sample metadata" value={form().metadata} placeholder="data/metadata.csv" onInput={(value) => update("metadata", value)} />
      <div class="grid grid-cols-2 gap-4"><Field label="Organism" value={form().organism} onInput={(value) => update("organism", value)} /><Field label="Reference" value={form().reference} onInput={(value) => update("reference", value)} /></div>
      <div class="grid grid-cols-2 gap-4"><Field label="Sample ID column" value={form().sampleColumn} onInput={(value) => update("sampleColumn", value)} /><Field label="Condition column" value={form().conditionColumn} onInput={(value) => update("conditionColumn", value)} /></div>
      <div class="grid grid-cols-2 gap-4"><Field label="Control" value={form().control} onInput={(value) => update("control", value)} /><Field label="Treatment" value={form().treatment} onInput={(value) => update("treatment", value)} /></div>
      <div class="grid grid-cols-2 gap-4"><Field label="Batch column" value={form().batchColumn} placeholder="Optional" onInput={(value) => update("batchColumn", value)} /><Field label="Adjusted p-value" value={form().adjustedPValue} onInput={(value) => update("adjustedPValue", value)} /></div>
    </div><div><SectionTitle title="Validation" /><Show when={preview()} fallback={<div class="mt-2 border-y border-border-weak-base py-6 text-11-regular text-text-weak">Enter project-relative file paths and validate them. Griffin will checksum both inputs and inspect the study design.</div>}>{(result) => <div class="mt-2 divide-y divide-border-weak-base border-y border-border-weak-base"><For each={result().checks}>{(check) => <CheckRow check={check} />}</For></div>}</Show><Show when={preview()}>{(result) => <><SectionTitle title="Execution plan" class="mt-6" /><ol class="mt-2 divide-y divide-border-weak-base border-y border-border-weak-base"><For each={result().plan}>{(step, index) => <li class="flex gap-2 py-2 text-10-regular text-text-base"><span class="font-mono text-text-weak">{index() + 1}</span><span>{step}</span></li>}</For></ol></>}</Show></div></div>
    <div class="mt-7 flex justify-end gap-2 border-t border-border-weak-base pt-4"><ActionButton disabled={busy()} onClick={() => void validate()}>Validate inputs</ActionButton><ActionButton disabled={busy() || !preview()} onClick={() => void create()}>Create tracked run</ActionButton></div>
  </div></div>
}

function Field(props: { label: string; value: string; placeholder?: string; onInput: (value: string) => void }) { return <label class="flex flex-col gap-1.5"><span class="text-11-medium text-text-weak">{props.label}</span><input class="h-9 rounded-xs border border-border-weak-base bg-surface-base px-3 text-12-regular text-text-strong outline-none focus:border-border-strong-base" value={props.value} placeholder={props.placeholder} onInput={(event) => props.onInput(event.currentTarget.value)} /></label> }
function ActionButton(props: { children: JSX.Element; disabled?: boolean; danger?: boolean; onClick: () => void }) { return <button type="button" class="h-8 rounded-xs border border-border-weak-base px-3 text-12-medium disabled:opacity-50" classList={{ "bg-surface-raised-base-active text-text-strong": !props.danger, "text-text-danger": !!props.danger }} disabled={props.disabled} onClick={props.onClick}>{props.children}</button> }
function SectionTitle(props: { title: string; class?: string }) { return <h2 class={`font-mono text-10-medium uppercase text-text-weak ${props.class ?? ""}`}>{props.title}</h2> }
function CheckRow(props: { check: Check }) { return <div class="flex gap-3 py-2.5"><span classList={{ "text-text-success": props.check.status === "pass", "text-text-warning": props.check.status === "warning", "text-text-danger": props.check.status === "fail" }}>{props.check.status === "pass" ? <IconCheckCircle size={13} /> : <IconAlertCircle size={13} />}</span><div><div class="text-11-medium text-text-strong">{props.check.label}</div><div class="mt-0.5 text-10-regular leading-4 text-text-weak">{props.check.message}</div></div></div> }
function Empty(props: { text: string }) { return <div class="flex min-h-40 items-center justify-center px-4 text-center text-11-regular text-text-weak">{props.text}</div> }
function StatusDot(props: { status: Run["status"] }) { return <span class="size-1.5 rounded-full" classList={{ "bg-text-success": props.status === "completed" || props.status === "ready", "bg-text-warning": props.status === "awaiting_approval" || props.status === "running", "bg-text-danger": props.status === "failed" || props.status === "blocked", "bg-text-weak": props.status === "cancelled" }} /> }
function StatusBadge(props: { status: Run["status"] }) { return <span class="flex h-7 items-center gap-2 rounded-xs border border-border-weak-base px-2.5 font-mono text-10-medium text-text-base"><StatusDot status={props.status} />{STATUS_LABEL[props.status]}</span> }
function relativeTime(time: number) { const minutes = Math.floor((Date.now() - time) / 60000); if (minutes < 1) return "now"; if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`; return `${Math.floor(hours / 24)}d` }
