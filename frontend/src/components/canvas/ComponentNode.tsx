import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { AlertTriangle, Code2, MessageSquarePlus, Radar } from "lucide-react";
import type { Component, NodeHealth } from "@/lib/types";
import { KIND_META } from "@/lib/architecture";
import { KindTile } from "@/lib/kinds";
import { NODE_H, NODE_W } from "@/lib/layout";
import { Dot, HEALTH } from "@/components/ui/misc";
import { useStore } from "@/store/useStore";
import { cn } from "@/lib/utils";

export type Visual = { health: NodeHealth; selected: boolean; impact: boolean; source: boolean; dim: boolean; findings: number; fresh: boolean };
export type FlowNode = Node<{ c: Component; v: Visual; vertical?: boolean }, "component">;

function ComponentNode({ data }: NodeProps<FlowNode>) {
  const { c, v, vertical } = data;
  const { select, setImpactPreview, setDraft, setOpenFile } = useStore.getState();
  const fileCount = c.files.length;
  const sub =
    c.kind === "runtime" ? c.blurb
    : c.kind === "integration" ? c.blurb
    : [c.meta?.stack, fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");

  return (
    <div className={cn("group relative transition-opacity duration-200", v.dim && "opacity-35", v.fresh && "animate-pop")} style={{ width: NODE_W }}>
      {/* hover toolbar (n8n-style) */}
      <div className="nodrag pointer-events-none absolute -top-9 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-line bg-card p-0.5 opacity-0 shadow-lift transition-all duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
        <ToolBtn label="Ask the agent about this" onClick={() => { select(c.id); setDraft("", c.id); }}><MessageSquarePlus size={13} /></ToolBtn>
        <ToolBtn label="What breaks if this changes?" onEnter={() => setImpactPreview(c.id)} onLeave={() => setImpactPreview(undefined)}><Radar size={13} /></ToolBtn>
        {fileCount > 0 && <ToolBtn label="Open code" onClick={() => { select(c.id); setOpenFile(c.files.find((f) => !/\.(md|json|txt)$/.test(f)) ?? c.files[0]); }}><Code2 size={13} /></ToolBtn>}
      </div>

      <div
        style={{ height: NODE_H }}
        className={cn(
          "relative flex items-center gap-3 rounded-xl border bg-card px-3.5 shadow-card transition-all duration-200",
          "border-line hover:border-line-2 hover:shadow-lift",
          v.selected && "border-ink shadow-lift ring-[3px] ring-ink/[0.06]",
          v.health === "working" && "node-working",
          v.health === "broken" && !v.selected && "border-bad/60 bg-[#fffaf9]",
          v.impact && "border-bad border-dashed bg-bad-soft/60",
          v.source && "border-ink ring-[3px] ring-bad/15",
          c.files.length === 0 && c.kind !== "runtime" && c.kind !== "integration" && "border-dashed",
        )}
      >
        <Handle type="target" position={vertical ? Position.Top : Position.Left} />
        <KindTile kind={c.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="dot text-[11px] uppercase leading-none text-mute">{KIND_META[c.kind].label}</span>
          </div>
          <div className="mt-1 truncate text-[14px] font-semibold leading-tight tracking-[-0.01em]">{c.label}</div>
          <div className="mt-1 truncate font-mono text-[10.5px] text-mute">{sub || c.blurb}</div>
        </div>
        <div className="flex flex-col items-end gap-1.5 self-stretch py-3">
          <span title={HEALTH[v.health].label}><Dot health={v.impact ? "broken" : v.health} /></span>
          {v.findings > 0 && (
            <span className={cn("mt-auto inline-flex items-center gap-0.5 rounded px-1 font-mono text-[10px]", v.health === "broken" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn")}>
              <AlertTriangle size={9} /> {v.findings}
            </span>
          )}
        </div>
        <Handle type="source" position={vertical ? Position.Bottom : Position.Right} />
      </div>

      {v.impact && <div className="absolute -bottom-5 left-3 font-mono text-[10px] text-bad">would need updating</div>}
      {v.health === "working" && <div className="absolute -bottom-5 left-3 font-mono text-[10px] text-signal">agent is writing…</div>}
    </div>
  );
}

function ToolBtn({ children, label, onClick, onEnter, onLeave }: { children: React.ReactNode; label: string; onClick?: () => void; onEnter?: () => void; onLeave?: () => void }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="flex h-6 w-6 items-center justify-center rounded-md text-ink-2 hover:bg-sunk hover:text-ink"
    >
      {children}
    </button>
  );
}

export default memo(ComponentNode);
