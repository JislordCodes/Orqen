import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type NodeChange,
} from "@xyflow/react";
import { LayoutGrid } from "lucide-react";
import { useModel } from "@/lib/useModel";
import { dependentsOf, healthOf } from "@/lib/architecture";
import { autoLayout } from "@/lib/layout";
import { KIND_STYLE } from "@/lib/kinds";
import { useStore } from "@/store/useStore";
import ComponentNode, { type FlowNode } from "./ComponentNode";
import { WireEdge, type FlowEdge } from "./WireEdge";
import { EmptyCanvas } from "./EmptyCanvas";
import { CanvasHud } from "./CanvasHud";
import { useIsMobile } from "@/lib/useIsMobile";
import { Button } from "@/components/ui/button";

const nodeTypes = { component: ComponentNode };
const edgeTypes = { wire: WireEdge };

export function Canvas() {
  const { arch, ws, broken, liveRun } = useModel();
  const mobile = useIsMobile();
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const impactPreviewId = useStore((s) => s.impactPreviewId);
  const draft = useStore((s) => s.draft);
  const draftScope = useStore((s) => s.draftScope);
  const projectId = useStore((s) => s.projectId);
  const { select } = useStore.getState();
  const { fitView } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const positions = useRef<Record<string, { x: number; y: number }>>({});
  const dragged = useRef<Set<string>>(new Set());
  const seen = useRef<Set<string>>(new Set());
  const [layoutTick, setLayoutTick] = useState(0);

  // Reset per project.
  useEffect(() => {
    positions.current = {};
    dragged.current = new Set();
    seen.current = new Set();
  }, [projectId]);

  // Re-layout when the set of components changes, keeping anything the user moved.
  const idKey = arch.nodes.map((n) => n.id).sort().join("|") + `#${layoutTick}#${mobile ? "TB" : "LR"}`;
  useEffect(() => {
    if (mobile) dragged.current = new Set(); // orientation changes reset manual moves
    const auto = autoLayout(arch.nodes, arch.wires, mobile ? "TB" : "LR");
    for (const [id, p] of Object.entries(auto)) if (!dragged.current.has(id)) positions.current[id] = p;
    const t = setTimeout(() => fitView(mobile ? { padding: 0.12, duration: 500, maxZoom: 0.95, minZoom: 0.55 } : { padding: 0.22, duration: 500, maxZoom: 1.05 }), 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  // Re-fit when the chat folds away or the window changes size (rotate, resize, split screen).
  const chatOpen = useStore((s) => s.chatOpen);
  const fit = () => fitView(mobile ? { padding: 0.12, duration: 400, maxZoom: 0.95, minZoom: 0.55 } : { padding: 0.22, duration: 400, maxZoom: 1.05 });
  useEffect(() => {
    if (!chatOpen && arch.nodes.length) { const t = setTimeout(fit, 250); return () => clearTimeout(t); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const on = () => { clearTimeout(t); t = setTimeout(() => !dragged.current.size && fit(), 200); };
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("resize", on); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile]);

  // Which nodes "would break": hover preview, or the scope of a prompt being typed.
  const impactSource = impactPreviewId ?? (draftScope && draft.trim() ? draftScope : undefined);
  const impact = useMemo(() => new Set(impactSource ? dependentsOf(impactSource, arch.wires) : []), [impactSource, arch.wires]);

  useEffect(() => {
    const freshIds = new Set(arch.nodes.filter((c) => !seen.current.has(c.id) && seen.current.size > 0).map((c) => c.id));
    arch.nodes.forEach((c) => seen.current.add(c.id));
    setNodes((prev) => {
      const prevPos = Object.fromEntries(prev.map((n) => [n.id, n.position]));
      return arch.nodes.map((c) => {
        const fresh = freshIds.has(c.id);
        const health = healthOf(c, arch, ws, broken);
        return {
          id: c.id,
          type: "component" as const,
          position: dragged.current.has(c.id) ? prevPos[c.id] ?? positions.current[c.id] : positions.current[c.id] ?? prevPos[c.id] ?? { x: 0, y: 0 },
          data: {
            c,
            vertical: mobile,
            v: {
              health,
              selected: c.id === selectedNodeId,
              impact: impact.has(c.id),
              source: c.id === impactSource,
              dim: !!impactSource && !impact.has(c.id) && c.id !== impactSource,
              findings: arch.findings.filter((f) => f.nodeIds.includes(c.id) && f.severity !== "info").length,
              fresh,
            },
          },
        };
      });
    });
  }, [arch, ws, broken, selectedNodeId, impact, impactSource, setNodes, idKey]);

  const edges: FlowEdge[] = useMemo(() => {
    const label = (id: string) => arch.nodes.find((n) => n.id === id)?.label ?? id;
    return arch.wires.map((w) => {
      const fromNode = arch.nodes.find((n) => n.id === w.from);
      const toNode = arch.nodes.find((n) => n.id === w.to);
      const working = (id?: string) => !!arch.nodes.find((n) => n.id === id)?.files.some((f) => ws.activeFiles.has(f));
      const state =
        impactSource && impact.has(w.from) && (impact.has(w.to) || w.to === impactSource) ? "impact"
        : impactSource ? "dim"
        : broken.has(w.from) && broken.has(w.to) ? "broken"
        : liveRun && (working(w.from) || working(w.to)) ? "live"
        : "idle";
      const color = state === "live" ? "#ff5a1f" : state === "broken" || state === "impact" ? "#d7392b" : "#bdb6a9";
      return {
        id: w.id,
        source: w.from,
        target: w.to,
        type: "wire" as const,
        className: state === "idle" ? undefined : `wire-${state}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
        data: { label: w.label, fromLabel: label(w.from), toLabel: label(w.to), state, dashed: w.dashed },
        zIndex: fromNode && toNode ? 0 : -1,
      };
    });
  }, [arch, ws, broken, liveRun, impact, impactSource]);

  const handleNodesChange = (changes: NodeChange<FlowNode>[]) => {
    for (const ch of changes) if (ch.type === "position" && ch.dragging && ch.position) dragged.current.add(ch.id);
    onNodesChange(changes);
  };

  const tidy = () => {
    dragged.current = new Set();
    setLayoutTick((t) => t + 1);
  };

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onNodeClick={(_, n) => select(n.id)}
        onPaneClick={() => select(undefined)}
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        minZoom={0.25}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color="#d6cfc2" />
        {arch.nodes.length > 0 && (
          <>
            <Controls position={mobile ? "top-right" : "bottom-left"} showInteractive={false} showFitView style={mobile ? { marginTop: 52 } : { marginBottom: 88 }} />
            {!mobile && <MiniMap className="!hidden xl:!block"
              position="bottom-right"
              pannable
              zoomable
              style={{ width: 150, height: 96, marginBottom: 88, background: "#fdfcf9" }}
              maskColor="rgba(245,242,236,0.65)"
              nodeBorderRadius={6}
              nodeColor={(n) => {
                const d = (n as FlowNode).data;
                return d.v.health === "broken" ? "#d7392b" : `${KIND_STYLE[d.c.kind].color}66`;
              }}
            />}
          </>
        )}
      </ReactFlow>

      {arch.nodes.length === 0 ? <EmptyCanvas /> : <CanvasHud />}
      {arch.nodes.length > 1 && (
        <div className="absolute right-3 top-3 z-10 md:right-4 md:top-4">
          <Button size={mobile ? "icon" : "sm"} variant="secondary" onClick={tidy} title="Re-run auto layout" aria-label="Tidy up">
            <LayoutGrid size={mobile ? 15 : 12} /> {!mobile && "Tidy up"}
          </Button>
        </div>
      )}
    </div>
  );
}
