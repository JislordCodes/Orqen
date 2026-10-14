import { useMemo } from "react";
import { Check, Crosshair, FileEdit, FilePlus2, History, Loader2, LocateFixed, RotateCcw, X } from "lucide-react";
import { useStore } from "@/store/useStore";
import { useModel } from "@/lib/useModel";
import { timelineOf } from "@/lib/workspace";
import type { Run } from "@/lib/types";
import { cn, duration, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/misc";
import { StepRow } from "@/components/chat/StepRow";
import { Markdownish } from "@/components/chat/Markdownish";

const INTENT: Record<Run["intent"], string> = { build: "Build", scoped: "Scoped", fix: "Fix", audit: "Audit", test: "Test" };

export function ExecutionsView() {
  const { runs } = useModel();
  const selectedRunId = useStore((s) => s.selectedRunId);
  const selectRun = useStore((s) => s.selectRun);
  const list = [...runs].reverse();
  const run = list.find((r) => r.id === selectedRunId) ?? list[0];

  if (!runs.length) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty icon={<History size={26} />} title="No executions yet">Every prompt you send becomes an execution you can replay step by step.</Empty>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-[340px_1fr] gap-4 p-4">
      <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-card">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="eyebrow">Executions</span>
          <span className="font-mono text-[10.5px] text-faint">{runs.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {list.map((r) => (
            <button
              key={r.id}
              onClick={() => selectRun(r.id)}
              className={cn("mb-0.5 flex w-full gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors", run?.id === r.id ? "bg-sunk" : "hover:bg-sunk/60")}
            >
              <StatusIcon status={r.status} />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[12.5px] leading-snug text-ink">{r.prompt}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-mute">
                  <span className="rounded bg-card px-1 py-[1px] shadow-card">{INTENT[r.intent]}</span>
                  {r.scope && <span className="flex items-center gap-0.5"><Crosshair size={9} /> {r.scope.label}</span>}
                  <span>{timeAgo(r.startedAt)}</span>
                  {r.endedAt && <span>· {duration(r.endedAt - r.startedAt)}</span>}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      {run && <RunDetail run={run} />}
    </div>
  );
}

function StatusIcon({ status }: { status: Run["status"] }) {
  const base = "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full";
  if (status === "running" || status === "queued") return <span className={cn(base, "bg-signal-soft text-signal")}><Loader2 size={11} className="animate-spin" /></span>;
  if (status === "error") return <span className={cn(base, "bg-bad-soft text-bad")}><X size={11} /></span>;
  return <span className={cn(base, "bg-ok-soft text-ok")}><Check size={11} /></span>;
}

function RunDetail({ run }: { run: Run }) {
  const { send, select, setTab } = useStore.getState();
  const items = useMemo(() => timelineOf(run), [run]);
  const steps = items.filter((i) => i.kind === "step").map((i) => (i.kind === "step" ? i.step : null)!);
  const changed = useMemo(() => {
    const m = new Map<string, "created" | "edited">();
    for (const s of steps) {
      if (s.state !== "ok") continue;
      const p = s.title.replace(/^(Wrote|Edited) /, "");
      if (s.tool === "create_file") m.set(p, m.get(p) ?? "created");
      if (s.tool === "str_replace") m.set(p, m.get(p) === "created" ? "created" : "edited");
    }
    return [...m.entries()];
  }, [steps]);
  const failed = steps.filter((s) => s.state === "fail").length;
  const busy = useModel().liveRun;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-card">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold leading-snug tracking-[-0.01em]">{run.prompt}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10.5px] text-mute">
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              {run.endedAt && <span>{duration(run.endedAt - run.startedAt)}</span>}
              <span>{steps.length} steps{failed ? <span className="text-bad"> · {failed} failed</span> : null}</span>
              <span className="text-faint">run {run.id.slice(0, 8)}</span>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {run.scope && (
              <Button size="sm" variant="secondary" onClick={() => { setTab("editor"); select(run.scope!.nodeId); }}>
                <LocateFixed size={12} /> On canvas
              </Button>
            )}
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => send(run.prompt, { scopeNodeId: run.scope?.nodeId, intent: run.intent })}>
              <RotateCcw size={12} /> Run again
            </Button>
          </div>
        </div>
        {run.scope && run.scope.impacted.length > 0 && (
          <p className="mt-3 text-[11.5px] text-mute">Scoped to <b className="text-ink-2">{run.scope.label}</b>, with {run.scope.impacted.length} dependent part{run.scope.impacted.length === 1 ? "" : "s"} re-checked.</p>
        )}
        {changed.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {changed.map(([p, how]) => (
              <span key={p} className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
                {how === "created" ? <FilePlus2 size={10} className="text-ok" /> : <FileEdit size={10} className="text-warn" />} {p}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <ol className="relative space-y-1 border-l border-line pl-5">
          {items.map((it) =>
            it.kind === "text" ? (
              <li key={it.id} className="relative py-1.5 text-[13px] leading-relaxed text-ink-2">
                <span className="absolute -left-[23.5px] top-3 h-2 w-2 rounded-full border border-line-2 bg-card" />
                <Markdownish text={it.text} />
              </li>
            ) : (
              <li key={it.step.id} className="relative">
                <span className={cn("absolute -left-[23px] top-3 h-[7px] w-[7px] rounded-full", it.step.state === "fail" ? "bg-bad" : it.step.state === "running" ? "bg-signal" : "bg-line-2")} />
                <StepRow step={it.step} />
              </li>
            ),
          )}
        </ol>
        {run.status === "error" && <p className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-[12px] text-bad">{run.error}</p>}
        {run.summary && run.status === "done" && (
          <div className="mt-4 rounded-xl border border-line bg-paper p-3">
            <div className="eyebrow mb-1">Summary</div>
            <p className="text-[12.5px] leading-relaxed text-ink-2">{run.summary}</p>
          </div>
        )}
      </div>
    </div>
  );
}
