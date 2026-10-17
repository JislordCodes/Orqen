import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronUp, CornerDownLeft, Crosshair, Radar, Sparkles, X } from "lucide-react";
import { useStore } from "@/store/useStore";
import { useModel } from "@/lib/useModel";
import { useIsMobile } from "@/lib/useIsMobile";
import { dependentsOf } from "@/lib/architecture";
import { timelineOf, type Step, type TimelineItem } from "@/lib/workspace";
import type { Run } from "@/lib/types";
import { KindIcon } from "@/lib/kinds";
import { cn, duration } from "@/lib/utils";
import { Markdownish } from "./Markdownish";
import { StepRow } from "./StepRow";
import { BuildProgress, PlanCard } from "./PlanCard";
import { planOf, type ProjectPlan } from "@/lib/plan";
import { Kbd } from "@/components/ui/misc";

/**
 * The chat bar along the bottom. Plain prompts build or change the whole system;
 * with a node in scope, the prompt is wrapped so the agent touches only that
 * component and re-checks everything that depends on it.
 */
export function ChatDock() {
  const { runs, liveRun, arch } = useModel();
  const open = useStore((s) => s.chatOpen);
  const draft = useStore((s) => s.draft);
  const scopeId = useStore((s) => s.draftScope);
  const focusTick = useStore((s) => s.focusTick);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const previewOpen = useStore((s) => s.preview.open);
  const { setChatOpen, setDraft, send } = useStore.getState();
  const input = useRef<HTMLTextAreaElement>(null);
  const mobile = useIsMobile();
  const scroller = useRef<HTMLDivElement>(null);

  const scope = arch.nodes.find((n) => n.id === scopeId);
  const impacted = useMemo(() => (scope ? dependentsOf(scope.id, arch.wires).map((id) => arch.nodes.find((n) => n.id === id)!).filter(Boolean) : []), [scope, arch]);
  const recent = runs.slice(-8);
  const lastEventCount = recent[recent.length - 1]?.events.length ?? 0;

  useEffect(() => {
    if (focusTick) input.current?.focus();
  }, [focusTick]);

  // "/" focuses the prompt from anywhere.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target as HTMLElement).closest("input,textarea,[contenteditable],.monaco-editor")) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastEventCount, open, runs.length]);

  // Autosize
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [draft]);

  const plan = useMemo(() => planOf(runs), [runs]);
  const needsUser = !!plan && plan.awaiting && !plan.approved; // a plan or questions wait for the user
  // Open the thread while the agent works; fold it away shortly after it finishes so the graph is the hero.
  const wasLive = useRef(!!liveRun);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    if (liveRun && !wasLive.current) setChatOpen(true);
    if (!liveRun && wasLive.current && !needsUser) t = setTimeout(() => setChatOpen(false), mobile ? 1200 : 2500);
    wasLive.current = !!liveRun;
    return () => clearTimeout(t);
  }, [liveRun, mobile, setChatOpen, needsUser]);

  const submit = () => {
    const text = draft.trim();
    if (!text || liveRun) return;
    send(text, { scopeNodeId: scope?.id });
    setDraft("", null);
  };

  const placeholder = liveRun
    ? mobile ? "Agent is working… draft your next change" : "The agent is working… you can write your next change, then send it when it finishes."
    : scope
      ? `Change ${scope.label} only… e.g. “add rate limiting”`
      : runs.length
        ? "Describe a change to the system…"
        : "Describe the app you want to build…";

  // On a phone the inspector and preview are full-width sheets, so the dock steps aside.
  if (mobile && (previewOpen || selectedNodeId)) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center transition-[padding] duration-300",
        mobile ? "px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" : "px-4 pb-4",
      )}
      // Slide left so the inspector / preview never covers the prompt.
      style={mobile ? undefined : { paddingRight: previewOpen ? "calc(min(720px, 58%) + 2rem)" : selectedNodeId ? 432 : undefined }}
    >
      <div className="pointer-events-auto w-[720px] max-w-full">
        {open && recent.length > 0 && (
          <div className="animate-pop mb-2 overflow-hidden rounded-2xl border border-line bg-card/95 shadow-float backdrop-blur">
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <span className="eyebrow">Agent</span>
              <button onClick={() => setChatOpen(false)} className="rounded p-1.5 text-mute hover:bg-sunk hover:text-ink" aria-label="Collapse">
                <ChevronDown size={14} />
              </button>
            </div>
            <div ref={scroller} className={cn("space-y-5 overflow-y-auto overscroll-contain px-4 py-4", mobile ? "max-h-[40dvh]" : "max-h-[42vh]")}>
              {recent.map((r) => <RunThread key={r.id} run={r} plan={plan} busy={!!liveRun} />)}
            </div>
          </div>
        )}

        <div className={cn("rounded-2xl border bg-card shadow-float transition-colors", scope ? "border-ink/30" : "border-line")}>
          {(scope || !open) && (
            <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
              {scope && (
                <>
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-sunk px-1.5 py-0.5 text-[11px] font-medium">
                    <Crosshair size={11} className="text-signal" />
                    <KindIcon kind={scope.kind} size={11} /> {scope.label}
                    <button onClick={() => setDraft(draft, null)} className="ml-0.5 text-mute hover:text-ink" aria-label="Remove scope"><X size={11} /></button>
                  </span>
                  {impacted.length > 0 && (
                    <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-mute">
                      <Radar size={11} className="shrink-0 text-bad" /> also re-checks {impacted.map((n) => n.label).join(", ")}
                    </span>
                  )}
                </>
              )}
              {!open && recent.length > 0 && (
                <button onClick={() => setChatOpen(true)} className="ml-auto flex items-center gap-1 py-1 text-[11px] text-mute hover:text-ink md:py-0">
                  {liveRun ? <span className="flex items-center gap-1 text-signal"><span className="pulse-dot h-1.5 w-1.5 rounded-full bg-signal" /> working</span> : "history"} <ChevronUp size={12} />
                </button>
              )}
            </div>
          )}
          <div className="flex items-end gap-2 p-2 pl-3.5">
            <Sparkles size={15} className={cn("mb-2.5 shrink-0", liveRun ? "pulse-dot text-signal" : "text-faint")} />
            <textarea
              ref={input}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
                if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
              }}
              placeholder={placeholder}
              className="max-h-40 min-h-[38px] flex-1 resize-none bg-transparent py-2 text-[16px] md:text-[14px] leading-snug text-ink outline-none placeholder:text-faint"
            />
            {!scope && selectedNodeId && !draft && (
              <button
                onClick={() => setDraft(draft, selectedNodeId)}
                className="mb-1.5 hidden shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-1 text-[11px] text-mute hover:border-ink hover:text-ink sm:flex"
              >
                <Crosshair size={11} /> Scope to selection
              </button>
            )}
            <button
              onClick={submit}
              disabled={!draft.trim() || !!liveRun}
              className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink md:h-9 md:w-9 text-paper transition-all hover:bg-signal disabled:bg-line disabled:text-faint"
              aria-label="Send"
            >
              <ArrowUp size={16} />
            </button>
          </div>
          <div className="hidden items-center justify-between px-3.5 pb-2 text-[10.5px] text-faint md:flex">
            <span className="flex items-center gap-1"><Kbd>/</Kbd> focus · <CornerDownLeft size={10} /> send · ⇧↵ new line</span>
            <span className="font-mono">one run at a time per project</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RunThread({ run, plan, busy }: { run: Run; plan?: ProjectPlan; busy: boolean }) {
  const items = useMemo(() => timelineOf(run), [run]);
  const harness = useMemo(() => {
    let planEv, features, phase;
    for (const e of run.events) {
      if (e.type === "plan") planEv = e.data;
      else if (e.type === "features") features = e.data;
      else if (e.type === "phase") phase = e.data;
    }
    return { planEv, features, phase };
  }, [run]);
  const live = run.status === "running" || run.status === "queued";
  const grouped = useMemo(() => groupSteps(items), [items]);
  return (
    <div className="space-y-2.5">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[13px] leading-snug text-paper">
          {run.scope && <div className="mb-1 flex items-center gap-1 font-mono text-[10px] text-paper/60"><Crosshair size={10} /> {run.scope.label}</div>}
          {run.prompt}
        </div>
      </div>
      <div className="space-y-2 text-[13px] leading-relaxed text-ink-2">
        {run.status === "queued" && <p className="font-mono text-[11px] text-mute">Queued. Waiting for a worker…</p>}
        {grouped.map((g, i) =>
          g.kind === "text" ? (
            <div key={g.id} className={cn(live && i === grouped.length - 1 && "caret")}><Markdownish text={g.text} /></div>
          ) : (
            <StepGroup key={g.steps[0].id} steps={g.steps} live={live && i === grouped.length - 1} />
          ),
        )}
        {harness.planEv && <PlanCard data={harness.planEv} plan={plan} busy={busy} />}
        {!harness.planEv && harness.features && harness.features.total > 0 && (
          <BuildProgress data={harness.features} session={harness.phase?.session} maxSessions={harness.phase?.max_sessions} />
        )}
        {run.status === "error" && <p className="rounded-lg bg-bad-soft px-3 py-2 text-[12px] text-bad">{run.error}</p>}
        {run.status === "done" && run.endedAt && (
          <p className="font-mono text-[10.5px] text-faint">Finished in {duration(run.endedAt - run.startedAt)} · {items.filter((x) => x.kind === "step").length} steps</p>
        )}
      </div>
    </div>
  );
}

type Group = { kind: "text"; id: string; text: string } | { kind: "steps"; steps: Step[] };
function groupSteps(items: TimelineItem[]): Group[] {
  const out: Group[] = [];
  for (const it of items) {
    if (it.kind === "text") out.push(it);
    else {
      const last = out[out.length - 1];
      if (last?.kind === "steps") last.steps.push(it.step);
      else out.push({ kind: "steps", steps: [it.step] });
    }
  }
  return out;
}

function StepGroup({ steps, live }: { steps: Step[]; live: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const fails = steps.filter((s) => s.state === "fail").length;
  const show = expanded || live || steps.length <= 3 ? steps : steps.slice(-2);
  return (
    <div className="rounded-xl border border-line bg-paper/60 p-1">
      {!expanded && !live && steps.length > 3 && (
        <button onClick={() => setExpanded(true)} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[11.5px] text-mute hover:bg-sunk/70">
          <ChevronDown size={12} /> {steps.length - 2} more steps{fails ? <span className="text-bad"> · {fails} failed</span> : null}
        </button>
      )}
      {show.map((s) => <StepRow key={s.id} step={s} compact />)}
    </div>
  );
}
