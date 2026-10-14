import { useState } from "react";
import { Check, ChevronRight, FlaskConical, Play, ShieldCheck, Wand2, Wrench, X } from "lucide-react";
import { useStore } from "@/store/useStore";
import { useModel } from "@/lib/useModel";
import type { CommandInfo, Severity } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Empty, SEVERITY } from "@/components/ui/misc";

/** Guardrails (instant, deterministic checks on the graph) + the test runs the agent actually executed. */
export function TestsView() {
  const { arch, ws, liveRun } = useModel();
  const { send, select, setTab } = useStore.getState();
  const tests = ws.commands.filter((c) => c.kind === "test").reverse();
  const latest = tests[0];
  const order: Severity[] = ["critical", "warning", "info"];
  const findings = [...arch.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const passing = tests.filter((t) => t.exit === 0).length;
  const crit = findings.filter((f) => f.severity === "critical").length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="grid grid-cols-4 gap-3">
          <Stat label="Last test run" value={latest ? (latest.exit === 0 ? "pass" : "fail") : "—"} tone={latest ? (latest.exit === 0 ? "ok" : "bad") : undefined} />
          <Stat label="Test runs passed" value={tests.length ? `${passing}/${tests.length}` : "0"} />
          <Stat label="Critical" value={String(crit)} tone={crit ? "bad" : "ok"} />
          <Stat label="Checks to review" value={String(findings.length - crit)} tone={findings.length - crit ? "warn" : undefined} />
        </div>

        <div className="mt-6 grid grid-cols-[1.1fr_1fr] gap-4">
          <section className="rounded-2xl border border-line bg-card shadow-card">
            <header className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <h2 className="text-[13px] font-semibold">Guardrails</h2>
                <p className="text-[11px] text-mute">Checked live against the graph after every step.</p>
              </div>
              <Button size="sm" variant="secondary" disabled={!!liveRun || !arch.nodes.length} onClick={() => send("Audit this project for security and architecture problems: missing auth on write endpoints, secrets in code, missing input validation, unhandled errors, and layering violations. List findings by severity. Don't change any code.", { intent: "audit" })}>
                <ShieldCheck size={12} /> Deep audit
              </Button>
            </header>
            <div className="p-2">
              {!findings.length ? (
                <Empty icon={<ShieldCheck size={22} />} title={arch.nodes.length ? "All clear" : "Nothing to check yet"}>
                  {arch.nodes.length ? "No guardrail is tripped right now." : "Build something and the checks start running."}
                </Empty>
              ) : (
                findings.map((f) => (
                  <div key={f.id} className="group flex gap-3 rounded-xl px-3 py-2.5 hover:bg-sunk/60">
                    <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", f.severity === "critical" ? "bg-bad" : f.severity === "warning" ? "bg-warn" : "bg-faint")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[12.5px] font-medium">{f.title}</span>
                        <span className={cn("rounded px-1 font-mono text-[9.5px] uppercase", SEVERITY[f.severity].soft, SEVERITY[f.severity].text)}>{SEVERITY[f.severity].label}</span>
                      </div>
                      <p className="mt-0.5 text-[11.5px] leading-snug text-mute">{f.detail}</p>
                      <div className="mt-2 flex gap-1.5">
                        <Button size="xs" variant="primary" disabled={!!liveRun} onClick={() => send(f.fixPrompt, { scopeNodeId: f.nodeIds.find((id) => arch.nodes.find((n) => n.id === id)?.files.length), intent: "fix" })}>
                          <Wrench size={10} /> Fix with agent
                        </Button>
                        {f.nodeIds[0] && arch.nodes.some((n) => n.id === f.nodeIds[0]) && (
                          <Button size="xs" variant="ghost" onClick={() => { setTab("editor"); select(f.nodeIds[0]); }}>Show on canvas</Button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-line bg-card shadow-card">
            <header className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <h2 className="text-[13px] font-semibold">Test runs</h2>
                <p className="text-[11px] text-mute">Every test command the agent ran in the sandbox.</p>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" disabled={!!liveRun || !arch.nodes.length} onClick={() => send("Run the full test suite. If anything fails, fix the code and re-run until it passes, then checkpoint.", { intent: "test" })}>
                  <Play size={11} /> Run
                </Button>
                <Button size="sm" variant="secondary" disabled={!!liveRun || !arch.nodes.length} onClick={() => send("Write tests for the main flows and the important error cases, run them, fix real bugs they find, and checkpoint.", { intent: "test" })}>
                  <Wand2 size={11} /> Write tests
                </Button>
              </div>
            </header>
            <div className="p-2">
              {!tests.length ? (
                <Empty icon={<FlaskConical size={22} />} title="No tests have run">Ask the agent to write tests, or they'll appear here as soon as it runs any.</Empty>
              ) : (
                tests.map((t) => <TestRow key={t.id} t={t} />)
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function TestRow({ t }: { t: CommandInfo }) {
  const [open, setOpen] = useState(false);
  const ok = t.exit === 0;
  const summary = t.output?.split("\n").reverse().find((l) => /passed|failed|error|ok|✓/i.test(l))?.trim();
  return (
    <div className={cn("rounded-xl", open && "bg-sunk/60")}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left hover:bg-sunk/60">
        <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full", ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")}>{ok ? <Check size={11} /> : <X size={11} />}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11.5px] text-ink-2">{t.cmd}</div>
          {summary && <div className={cn("truncate font-mono text-[10.5px]", ok ? "text-mute" : "text-bad")}>{summary}</div>}
        </div>
        <span className="font-mono text-[10px] text-faint">{timeAgo(t.at)}</span>
        <ChevronRight size={12} className={cn("text-faint transition-transform", open && "rotate-90")} />
      </button>
      {open && <pre className="mx-3 mb-2 max-h-64 overflow-auto rounded-lg border border-line bg-card p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{t.output}</pre>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" | "warn" }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-4 py-3.5 shadow-card">
      <div className="eyebrow">{label}</div>
      <div className={cn("dot mt-1.5 text-[30px] leading-none", tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink")}>{value}</div>
    </div>
  );
}
