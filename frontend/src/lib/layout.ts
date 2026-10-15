import dagre from "@dagrejs/dagre";
import type { Component, Wire } from "./types";
import { KIND_META } from "./architecture";

export const NODE_W = 236;
export const NODE_H = 86;

/** Left-to-right flow, like n8n: callers on the left, what they depend on to the right.
 *  Phones get top-to-bottom ("TB") so the graph scrolls with the thumb instead of shrinking. */
export function autoLayout(nodes: Component[], wires: Wire[], dir: "LR" | "TB" = "LR") {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: dir, nodesep: dir === "TB" ? 28 : 36, ranksep: dir === "TB" ? 64 : 96, marginx: 40, marginy: 40, ranker: "network-simplex" });
  g.setDefaultEdgeLabel(() => ({}));
  const sorted = [...nodes].sort((a, b) => KIND_META[a.kind].order - KIND_META[b.kind].order);
  for (const n of sorted) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const w of wires) if (!w.dashed) g.setEdge(w.from, w.to);
  // Tests sit under what they verify rather than pushing the whole graph right.
  for (const w of wires) if (w.dashed) g.setEdge(w.from, w.to, { minlen: 1, weight: 0 });
  dagre.layout(g);
  const pos: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) pos[n.id] = { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
  }
  // Park Setup below everything: it has no wires and would otherwise float at the start.
  const setup = nodes.find((n) => n.kind === "config");
  if (setup) {
    const others = Object.entries(pos).filter(([id]) => id !== setup.id);
    const maxY = Math.max(0, ...others.map(([, p]) => p.y));
    const minX = Math.min(0, ...others.map(([, p]) => p.x));
    pos[setup.id] = { x: others.length ? minX : 40, y: (others.length ? maxY : 0) + NODE_H + 60 };
  }
  return pos;
}
