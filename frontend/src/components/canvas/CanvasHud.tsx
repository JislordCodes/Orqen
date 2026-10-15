import { GitCommitHorizontal, Radar } from "lucide-react";
import { useModel } from "@/lib/useModel";
import { useStore } from "@/store/useStore";
import { timeAgo } from "@/lib/utils";

/** Top-left glance: what the system is, how healthy, last known-good state. */
export function CanvasHud() {
  const { arch, ws, liveRun } = useModel();
  const project = useStore((s) => s.projects.find((p) => p.id === s.projectId));
  const impactPreviewId = useStore((s) => s.impactPreviewId);
  const draftScope = useStore((s) => s.draftScope);
  const draft = useStore((s) => s.draft);
  const setTab = useStore((s) => s.setTab);
  const crit = arch.findings.filter((f) => f.severity === "critical").length;
  const warn = arch.findings.filter((f) => f.severity === "warning").length;
  const cp = ws.checkpoints[ws.checkpoints.length - 1];
  const files = Object.keys(ws.files).length;
  const impactId = impactPreviewId ?? (draftScope && draft.trim() ? draftScope : undefined);
  const impactNode = arch.nodes.find((n) => n.id === impactId);

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-4.5rem)] flex-col gap-2 md:left-4 md:top-4 md:max-w-none">
      <div className="pointer-events-auto rounded-xl border border-line bg-card/90 px-3.5 py-2.5 shadow-card backdrop-blur">
        <div className="hidden text-[13px] font-semibold tracking-[-0.01em] md:block">{project?.name}</div>
        <div className="flex items-center gap-3 font-mono md:mt-1 text-[10.5px] text-mute">
          <span><b className="dot text-[13px] text-ink">{arch.nodes.length}</b> components</span>
          <span><b className="dot text-[13px] text-ink">{files}</b> files</span>
          {cp && (
            <span className="flex items-center gap-1" title={cp.message}>
              <GitCommitHorizontal size={11} /> {timeAgo(cp.at)}
            </span>
          )}
        </div>
        {(crit > 0 || warn > 0) && (
          <button onClick={() => setTab("tests")} className="mt-2 flex items-center gap-2 text-[11px] font-medium hover:underline">
            {crit > 0 && <span className="text-bad">● {crit} critical</span>}
            {warn > 0 && <span className="text-warn">● {warn} to review</span>}
          </button>
        )}
        {liveRun && <div className="mt-2 flex items-center gap-1.5 text-[11px] text-signal"><span className="pulse-dot h-1.5 w-1.5 rounded-full bg-signal" /> Agent is building</div>}
      </div>
      {impactNode && (
        <div className="animate-pop rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2 text-[11.5px] text-bad shadow-card">
          <div className="flex items-center gap-1.5 font-semibold"><Radar size={12} /> Blast radius of {impactNode.label}</div>
          <div className="mt-0.5 text-bad/80">Red dashed parts depend on it and would need to change too.</div>
        </div>
      )}
    </div>
  );
}
