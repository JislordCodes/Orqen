import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NodeHealth, Severity } from "@/lib/types";

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-card px-1 font-mono text-[10px] text-mute", className)}>{children}</kbd>;
}

export function Chip({ className, ...p }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("inline-flex items-center gap-1 rounded-md border border-line bg-card px-1.5 py-0.5 font-mono text-[11px] text-ink-2", className)} {...p} />;
}

export const HEALTH: Record<NodeHealth, { dot: string; label: string; text: string; soft: string }> = {
  idle: { dot: "bg-faint", label: "Not built", text: "text-mute", soft: "bg-sunk" },
  working: { dot: "bg-signal pulse-dot", label: "Agent working", text: "text-signal", soft: "bg-signal-soft" },
  ok: { dot: "bg-ok", label: "Healthy", text: "text-ok", soft: "bg-ok-soft" },
  warn: { dot: "bg-warn", label: "Needs attention", text: "text-warn", soft: "bg-warn-soft" },
  broken: { dot: "bg-bad", label: "Broken", text: "text-bad", soft: "bg-bad-soft" },
};

export const SEVERITY: Record<Severity, { text: string; soft: string; border: string; label: string }> = {
  critical: { text: "text-bad", soft: "bg-bad-soft", border: "border-bad/25", label: "Critical" },
  warning: { text: "text-warn", soft: "bg-warn-soft", border: "border-warn/25", label: "Warning" },
  info: { text: "text-mute", soft: "bg-sunk", border: "border-line", label: "Note" },
};

export function Dot({ health, className }: { health: NodeHealth; className?: string }) {
  return <span className={cn("inline-block h-[7px] w-[7px] rounded-full", HEALTH[health].dot, className)} />;
}

export function Dialog({ open, onClose, title, children, width = 440 }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; width?: number }) {
  React.useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="animate-fade fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div style={{ width }} className="animate-pop max-w-full rounded-2xl border border-line bg-card shadow-float" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-mute hover:bg-sunk hover:text-ink" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-mute">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "h-9 w-full rounded-lg border border-line bg-white px-3 text-[13px] text-ink placeholder:text-faint outline-none transition focus:border-ink/40 focus:ring-4 focus:ring-ink/5";

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {children && <div className="mt-1 max-w-xs text-xs text-mute">{children}</div>}
    </div>
  );
}
