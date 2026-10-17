import { useState } from "react";
import { Check, ChevronDown, ChevronUp, CircleHelp, Circle, ListChecks, Rocket } from "lucide-react";
import { useStore } from "@/store/useStore";
import type { FeatureSummary, PlanPayload } from "@/lib/types";
import type { ProjectPlan } from "@/lib/plan";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The planner's output, shown in the thread: what will be built (in plain words), the parts of the
 * system, and every feature with its pass mark. Nothing is built until the user approves it here;
 * anything they type instead revises the plan.
 */
export function PlanCard({ data, plan, busy }: { data: PlanPayload; plan?: ProjectPlan; busy: boolean }) {
  const [technical, setTechnical] = useState(false);
  const [all, setAll] = useState(false);
  const { approvePlan, setDraft } = useStore.getState();
  // Live pass marks come from the project plan when this card is the current plan.
  const current = plan && plan.summary === data.summary ? plan : undefined;
  const features = current?.features ?? data.features;
  const passing = features.filter((f) => f.passes).length;
  const comps = data.architecture?.components ?? [];

  if (data.questions.length) {
    return (
      <div className="rounded-2xl border border-line bg-card p-3 shadow-card">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold"><CircleHelp size={13} className="text-signal" /> A few questions before I plan</div>
        <ol className="space-y-1.5 text-[12.5px] text-ink-2">
          {data.questions.map((q, i) => (
            <li key={i} className="flex gap-2"><span className="font-mono text-[11px] text-faint">{i + 1}.</span><span>{q}</span></li>
          ))}
        </ol>
        <p className="mt-2 text-[11px] text-mute">Answer in the chat. Short answers are fine.</p>
      </div>
    );
  }

  const shown = all ? features : features.slice(0, 6);
  const canApprove = !!current && current.awaiting && !current.approved && !busy;

  return (
    <div className="rounded-2xl border border-line bg-card shadow-card">
      <div className="flex items-start justify-between gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold"><ListChecks size={13} className="text-signal" /> The plan</div>
          <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{data.summary}</p>
        </div>
        <button onClick={() => setTechnical(!technical)} className="shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-mute hover:bg-sunk">
          {technical ? "Technical" : "Simple"}
        </button>
      </div>

      {comps.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">
          {comps.map((c) => (
            <span key={c.id} title={technical ? c.responsibility : c.plain} className="rounded-full bg-sunk px-2 py-0.5 text-[11px] text-ink-2">
              {c.name ?? c.id}{technical && c.tech ? <span className="text-faint"> · {c.tech}</span> : null}
            </span>
          ))}
        </div>
      )}

      <div className="px-2 py-1.5">
        <div className="flex items-center justify-between px-1 pb-1 font-mono text-[10.5px] text-mute">
          <span>{features.length} features</span>
          <span>{passing}/{features.length} verified</span>
        </div>
        <Progress done={passing} total={features.length} />
        <ul className="mt-1">
          {shown.map((f) => (
            <li key={f.id} className="flex items-start gap-2 rounded-lg px-1 py-1 text-[12px]" title={f.evidence}>
              {f.passes ? <Check size={12} className="mt-0.5 shrink-0 text-ok" /> : <Circle size={11} className="mt-0.5 shrink-0 text-faint" />}
              <span className="font-mono text-[10.5px] text-faint">{f.id}</span>
              <span className={cn("min-w-0 flex-1", f.passes ? "text-ink-2" : "text-ink")}>{technical ? f.title : f.plain || f.title}</span>
            </li>
          ))}
        </ul>
        {features.length > 6 && (
          <button onClick={() => setAll(!all)} className="flex w-full items-center gap-1 px-1 py-1 text-[11px] text-mute hover:text-ink">
            {all ? <ChevronUp size={11} /> : <ChevronDown size={11} />} {all ? "Show less" : `Show all ${features.length}`}
          </button>
        )}
      </div>

      {canApprove && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
          <Button size="sm" variant="signal" onClick={() => approvePlan()}><Rocket size={12} /> Approve and build</Button>
          <button onClick={() => setDraft("Change the plan: ", null)} className="text-[11.5px] text-mute hover:text-ink">or tell me what to change</button>
        </div>
      )}
    </div>
  );
}

/** Feature progress for a build run, from its latest features event. */
export function BuildProgress({ data, session, maxSessions }: { data: FeatureSummary; session?: number; maxSessions?: number }) {
  return (
    <div className="rounded-xl border border-line bg-paper/60 px-3 py-2">
      <div className="mb-1 flex items-center justify-between font-mono text-[10.5px] text-mute">
        <span>{data.passing}/{data.total} features verified</span>
        {session ? <span>session {session}{maxSessions ? ` of up to ${maxSessions}` : ""}</span> : null}
      </div>
      <Progress done={data.passing} total={data.total} />
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="h-1 overflow-hidden rounded-full bg-sunk">
      <div className="h-full rounded-full bg-signal transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}
