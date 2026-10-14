import { Blocks, Database, FlaskConical, Globe, KeyRound, Layout, Plug, Server, Settings2, Zap } from "lucide-react";
import type { Kind } from "./types";

export const KIND_STYLE: Record<Kind, { icon: typeof Layout; color: string }> = {
  runtime: { icon: Zap, color: "#1a1916" },
  interface: { icon: Layout, color: "#4a63e7" },
  api: { icon: Server, color: "#ff5a1f" },
  auth: { icon: KeyRound, color: "#8b5cf6" },
  logic: { icon: Blocks, color: "#0f9a94" },
  data: { icon: Database, color: "#d0457f" },
  integration: { icon: Plug, color: "#7a6f5f" },
  tests: { icon: FlaskConical, color: "#2e8b57" },
  config: { icon: Settings2, color: "#8c877d" },
};

export const GlobeIcon = Globe;

export function KindIcon({ kind, size = 16, className }: { kind: Kind; size?: number; className?: string }) {
  const { icon: I, color } = KIND_STYLE[kind];
  return <I size={size} style={{ color }} className={className} strokeWidth={1.75} />;
}

export function KindTile({ kind, size = 36 }: { kind: Kind; size?: number }) {
  const { color } = KIND_STYLE[kind];
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[10px] border"
      style={{ width: size, height: size, background: `${color}12`, borderColor: `${color}26` }}
    >
      <KindIcon kind={kind} size={Math.round(size * 0.47)} />
    </div>
  );
}
