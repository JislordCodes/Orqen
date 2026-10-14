import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import { Plus } from "lucide-react";
import { useStore } from "@/store/useStore";
import { cn } from "@/lib/utils";

export type WireData = { label: string; fromLabel: string; toLabel: string; state: "idle" | "live" | "broken" | "impact" | "dim"; dashed?: boolean };
export type FlowEdge = Edge<WireData, "wire">;

export function WireEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<FlowEdge>) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const d = data!;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={d.dashed ? { strokeDasharray: "2 4" } : undefined} />
      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          className={cn("nodrag nopan group/wire pointer-events-auto absolute flex items-center gap-1", d.state === "dim" && "opacity-25")}
        >
          <span
            className={cn(
              "rounded-md border bg-paper px-1.5 py-[1px] font-mono text-[10px] leading-4 transition-colors",
              d.state === "live" ? "border-signal/40 text-signal" : d.state === "broken" || d.state === "impact" ? "border-bad/40 text-bad" : "border-line text-mute",
            )}
          >
            {d.label}
          </span>
          {!d.dashed && (
            <button
              title={`Add a step between ${d.fromLabel} and ${d.toLabel}`}
              onClick={() => useStore.getState().setDraft(`Add a new component between ${d.fromLabel} and ${d.toLabel} that `, null)}
              className="flex h-[18px] w-[18px] items-center justify-center rounded-md border border-line bg-card text-mute opacity-0 shadow-card transition-all group-hover/wire:opacity-100 hover:border-ink hover:text-ink"
            >
              <Plus size={11} />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
