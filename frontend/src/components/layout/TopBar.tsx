import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe, Plus, Settings, ShieldCheck, Trash2 } from "lucide-react";
import { useStore, type Tab } from "@/store/useStore";
import { useModel } from "@/lib/useModel";
import { useIsMobile } from "@/lib/useIsMobile";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill="#1A1916" />
        <g fill="#F6F3EE"><circle cx="10" cy="10" r="2.2" /><circle cx="16" cy="10" r="2.2" /><circle cx="22" cy="10" r="2.2" /><circle cx="10" cy="16" r="2.2" /><circle cx="22" cy="16" r="2.2" /><circle cx="10" cy="22" r="2.2" /><circle cx="16" cy="22" r="2.2" /></g>
        <circle cx="22" cy="22" r="2.6" fill="#FF5A1F" />
      </svg>
      {!compact && <span className="dot text-[19px] leading-none tracking-tight">orqen</span>}
    </div>
  );
}

export function TopBar() {
  const tab = useStore((s) => s.tab);
  const mode = useStore((s) => s.mode);
  const health = useStore((s) => s.health);
  const { setTab, openPreview, setSettingsOpen, send } = useStore.getState();
  const { arch, liveRun, runs } = useModel();
  const issues = arch.findings.filter((f) => f.severity !== "info").length;
  const mobile = useIsMobile();
  const audit = () => send("Audit this project for security and architecture problems: missing auth on write endpoints, secrets in code, missing input validation, unhandled errors, and layering violations. List findings by severity. Don't change any code.", { intent: "audit" });
  const statusDot = <span className={cn("h-1.5 w-1.5 rounded-full", mode === "demo" ? "bg-signal" : health === "ok" ? "bg-ok" : health === "down" ? "bg-bad" : "bg-faint")} />;
  const statusText = mode === "demo" ? "Demo" : health === "down" ? "Offline" : "Live";

  const tabs: { id: Tab; label: string; badge?: React.ReactNode }[] = [
    { id: "editor", label: "Editor" },
    { id: "executions", label: "Executions", badge: runs.length ? <span className="font-mono text-[10px] text-faint">{runs.length}</span> : null },
    { id: "tests", label: "Tests", badge: issues ? <span className="rounded bg-warn-soft px-1 font-mono text-[10px] text-warn">{issues}</span> : null },
  ];

  if (mobile) {
    // Phone: one compact row of identity + actions, then the tabs as a full-width segmented control.
    return (
      <header className="relative z-40 border-b border-line bg-paper/90 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="flex h-10 items-center gap-2">
          <Wordmark compact />
          <div className="min-w-0 flex-1"><ProjectSwitcher compact /></div>
          <button onClick={() => setSettingsOpen(true)} className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-[12px] text-mute active:bg-sunk" aria-label="Connection settings">
            {statusDot} {statusText}
          </button>
          <button onClick={audit} disabled={!!liveRun || !arch.nodes.length} className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-card text-ink-2 disabled:opacity-40" aria-label="Audit">
            <ShieldCheck size={16} />
          </button>
          <button onClick={openPreview} className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink text-paper" aria-label="Preview">
            <Globe size={16} />
          </button>
        </div>
        <nav className="mt-1.5 grid grid-cols-3 gap-0.5 rounded-xl border border-line bg-card p-0.5 shadow-card">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={cn("flex h-9 items-center justify-center gap-1.5 rounded-[9px] text-[13px] font-medium", tab === t.id ? "bg-ink text-paper" : "text-ink-2 active:bg-sunk")}>
              {t.label}
              {t.badge}
            </button>
          ))}
        </nav>
      </header>
    );
  }

  return (
    <header className="relative z-40 grid h-14 grid-cols-[1fr_auto_1fr] items-center border-b border-line bg-paper/80 px-4 backdrop-blur">
      <div className="flex items-center gap-3">
        <Wordmark />
        <span className="h-5 w-px bg-line" />
        <ProjectSwitcher />
      </div>

      <nav className="flex items-center gap-0.5 rounded-xl border border-line bg-card p-0.5 shadow-card">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn("flex h-7 items-center gap-1.5 rounded-[9px] px-3 text-[12.5px] font-medium transition-all", tab === t.id ? "bg-ink text-paper" : "text-ink-2 hover:bg-sunk")}
          >
            {t.label}
            {t.badge}
          </button>
        ))}
      </nav>

      <div className="flex items-center justify-end gap-2">
        <button onClick={() => setSettingsOpen(true)} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-mute hover:bg-sunk hover:text-ink" title="Connection settings">
          {statusDot}
          {statusText}
          <Settings size={12} />
        </button>
        <Button size="sm" variant="secondary" disabled={!!liveRun || !arch.nodes.length} onClick={audit}>
          <ShieldCheck size={13} /> Audit
        </Button>
        <Button size="sm" variant="primary" onClick={openPreview}>
          <Globe size={13} /> Preview
        </Button>
      </div>
    </header>
  );
}

function ProjectSwitcher({ compact = false }: { compact?: boolean }) {
  const projects = useStore((s) => s.projects);
  const projectId = useStore((s) => s.projectId);
  const { switchProject, setNewProjectOpen, deleteProject } = useStore.getState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = projects.find((p) => p.id === projectId);

  useEffect(() => {
    const close = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className={cn("flex max-w-full items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium hover:bg-sunk", compact ? "h-9" : "h-7")}>
        <span className="truncate">{current?.name}</span>
        {!compact && <span className="font-mono text-[10.5px] font-normal text-faint">/{current?.id}</span>}
        <ChevronDown size={13} className="shrink-0 text-mute" />
      </button>
      {open && (
        <div className="animate-pop absolute left-0 top-10 w-[min(16rem,calc(100vw-1.5rem))] rounded-xl border border-line bg-card p-1 shadow-float">
          <div className="eyebrow px-2 pb-1 pt-1.5">Projects</div>
          {projects.map((p) => (
            <div key={p.id} className="group flex items-center rounded-lg hover:bg-sunk">
              <button onClick={() => { switchProject(p.id); setOpen(false); }} className="flex flex-1 items-center gap-2 px-2 py-2.5 text-left text-[13px] md:py-1.5 md:text-[12.5px]">
                <span className="w-3">{p.id === projectId && <Check size={12} />}</span>
                <span className="flex-1 truncate">{p.name}</span>
                <span className="font-mono text-[10px] text-faint">{p.id}</span>
              </button>
              {projects.length > 1 && (
                <button
                  onClick={() => confirm(`Remove “${p.name}” from this browser? The sandbox on the server is not deleted.`) && deleteProject(p.id)}
                  className="mr-1 rounded p-1.5 text-faint hover:text-bad md:opacity-0 md:group-hover:opacity-100"
                  aria-label="Remove project"
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
          <div className="my-1 h-px bg-line" />
          <button onClick={() => { setNewProjectOpen(true); setOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-[13px] text-ink-2 hover:bg-sunk md:py-1.5 md:text-[12.5px]">
            <Plus size={12} /> New project
          </button>
        </div>
      )}
    </div>
  );
}
