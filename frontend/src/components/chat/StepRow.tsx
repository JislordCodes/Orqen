import { useState } from "react";
import { Check, ChevronRight, FileEdit, FilePlus2, FileSearch, FolderTree, GitCommitHorizontal, Loader2, Play, ScrollText, Search, Square, Terminal, X } from "lucide-react";
import type { Step } from "@/lib/workspace";
import { cn, duration } from "@/lib/utils";

const ICON: Record<string, typeof Terminal> = {
  list_dir: FolderTree, view_file: FileSearch, grep: Search, create_file: FilePlus2, str_replace: FileEdit,
  run_command: Terminal, start_process: Play, read_process_logs: ScrollText, stop_process: Square, checkpoint: GitCommitHorizontal,
};

export function StepRow({ step, compact = false }: { step: Step; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const I = ICON[step.tool] ?? Terminal;
  const isCmd = step.tool === "run_command";
  return (
    <div className={cn("rounded-lg", open && "bg-sunk/70")}>
      <button onClick={() => step.output && setOpen(!open)} className={cn("group flex w-full items-center gap-2 rounded-lg px-1.5 text-left", compact ? "py-[3px]" : "py-1.5 hover:bg-sunk/70")}>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {step.state === "running" ? <Loader2 size={12} className="animate-spin text-signal" />
          : step.state === "fail" ? <X size={12} className="text-bad" />
          : <Check size={12} className="text-ok" />}
        </span>
        <I size={12} className="shrink-0 text-faint" />
        <span className={cn("min-w-0 flex-1 truncate text-[12px]", isCmd ? "font-mono text-[11.5px] text-ink-2" : "text-ink-2", step.state === "fail" && "text-bad")}>{step.title}</span>
        {step.detail && !compact && <span className="hidden truncate font-mono text-[10.5px] text-faint sm:inline">{step.detail}</span>}
        {step.endAt && !compact && <span className="font-mono text-[10px] text-faint">{duration(step.endAt - step.at)}</span>}
        {step.output && <ChevronRight size={11} className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")} />}
      </button>
      {open && step.output && (
        <pre className="mx-1.5 mb-1.5 max-h-56 overflow-auto rounded-md border border-line bg-card p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{step.output}</pre>
      )}
    </div>
  );
}
