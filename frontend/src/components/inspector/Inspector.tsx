import { useMemo } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, FileText, Radar, Wrench, X } from "lucide-react";
import { useStore } from "@/store/useStore";
import { useModel } from "@/lib/useModel";
import { dependenciesOf, dependentsOf, healthOf, KIND_META } from "@/lib/architecture";
import { KindIcon, KindTile } from "@/lib/kinds";
import type { Component, Kind } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { stepsOf } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Dot, Empty, HEALTH, SEVERITY } from "@/components/ui/misc";
import { StepRow } from "@/components/chat/StepRow";
import { CodeView } from "./CodeView";

const SUGGEST: Record<Kind, string[]> = {
  api: ["Add rate limiting", "Validate request bodies", "Return JSON errors, not HTML"],
  interface: ["Add loading and empty states", "Make it work on mobile", "Improve keyboard accessibility"],
  data: ["Add created_at timestamps", "Add an index for common lookups", "Rename a field"],
  auth: ["Add password reset", "Rate-limit login attempts", "Add roles: admin and member"],
  logic: ["Handle edge cases", "Add unit tests for this", "Split into smaller functions"],
  tests: ["Cover the error cases", "Add an end-to-end test", "Run the tests and fix failures"],
  runtime: ["Restart the server", "Show me the latest logs", "Add a health check endpoint"],
  integration: ["Handle failures and retries", "Add webhook handling", "Mock it in tests"],
  config: ["Write a better README", "Add a Dockerfile", "Pin dependency versions"],
};

export function Inspector() {
  const { arch, ws, broken, runs } = useModel();
  const id = useStore((s) => s.selectedNodeId);
  const tab = useStore((s) => s.inspectorTab);
  const { select, setInspectorTab } = useStore.getState();
  const node = arch.nodes.find((n) => n.id === id);
  if (!node) return null;
  const health = healthOf(node, arch, ws, broken);

  return (
    <aside className="animate-pop absolute bottom-4 right-4 top-4 z-30 flex w-[400px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-float">
      <header className="border-b border-line px-4 pb-0 pt-4">
        <div className="flex items-start gap-3">
          <KindTile kind={node.kind} size={40} />
          <div className="min-w-0 flex-1">
            <div className="dot text-[11px] uppercase text-mute">{KIND_META[node.kind].label}</div>
            <h2 className="truncate text-[16px] font-semibold tracking-[-0.01em]">{node.label}</h2>
            <div className={cn("mt-0.5 flex items-center gap-1.5 text-[11.5px]", HEALTH[health].text)}>
              <Dot health={health} /> {HEALTH[health].label}
            </div>
          </div>
          <button onClick={() => select(undefined)} className="rounded-md p-1 text-mute hover:bg-sunk hover:text-ink" aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <nav className="mt-3 flex gap-4 text-[12.5px]">
          {(["overview", "code", "activity"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setInspectorTab(t)}
              className={cn("-mb-px border-b-[1.5px] pb-2 capitalize transition-colors", tab === t ? "border-ink font-medium text-ink" : "border-transparent text-mute hover:text-ink")}
            >
              {t}
              {t === "code" && node.files.length > 0 && <span className="ml-1 font-mono text-[10px] text-faint">{node.files.length}</span>}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "overview" && <Overview node={node} />}
        {tab === "code" && <CodeView node={node} />}
        {tab === "activity" && <Activity node={node} runs={runs} />}
      </div>

      <Footer node={node} />
    </aside>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3.5 last:border-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="eyebrow">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Overview({ node }: { node: Component }) {
  const { arch, ws } = useModel();
  const { select, setImpactPreview, setOpenFile, send, openPreview } = useStore.getState();
  const deps = dependenciesOf(node.id, arch.wires);
  const users = arch.wires.filter((w) => w.to === node.id).map((w) => w.from);
  const blast = dependentsOf(node.id, arch.wires);
  const findings = arch.findings.filter((f) => f.nodeIds.includes(node.id));
  const byId = (i: string) => arch.nodes.find((n) => n.id === i)!;
  const wireLabel = (from: string, to: string) => arch.wires.find((w) => w.from === from && w.to === to)?.label;

  return (
    <>
      <Section title="What it does">
        <p className="text-[13px] leading-relaxed text-ink-2">{node.blurb}.</p>
        {(node.meta?.stack || node.meta?.package) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(node.meta.stack ?? node.meta.package)!.split(" · ").map((s) => (
              <span key={s} className="rounded-md border border-line bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">{s}</span>
            ))}
          </div>
        )}
        {node.kind === "runtime" && (
          <div className="mt-3 space-y-2">
            <code className="block rounded-lg bg-sunk px-2.5 py-1.5 font-mono text-[11px] text-ink-2">$ {node.meta?.command}</code>
            <Button size="sm" variant="secondary" onClick={openPreview}><ExternalLink size={12} /> Open preview</Button>
          </div>
        )}
      </Section>

      {findings.length > 0 && (
        <Section title="Guardrails">
          <div className="space-y-2">
            {findings.map((f) => (
              <div key={f.id} className={cn("rounded-xl border p-3", SEVERITY[f.severity].border, SEVERITY[f.severity].soft)}>
                <div className={cn("text-[12.5px] font-semibold", SEVERITY[f.severity].text)}>{f.title}</div>
                <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{f.detail}</p>
                <Button size="xs" variant="secondary" className="mt-2" onClick={() => send(f.fixPrompt, { scopeNodeId: node.files.length ? node.id : undefined, intent: "fix" })}>
                  <Wrench size={11} /> Fix with agent
                </Button>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Connections">
        {deps.length + users.length === 0 ? (
          <p className="text-[12px] text-mute">Standalone. Nothing calls it and it calls nothing.</p>
        ) : (
          <div className="space-y-1">
            {users.map((u) => (
              <ConnRow key={u} node={byId(u)} dir="in" label={wireLabel(u, node.id)} onClick={() => select(u)} />
            ))}
            {deps.map((d) => (
              <ConnRow key={d} node={byId(d)} dir="out" label={wireLabel(node.id, d)} onClick={() => select(d)} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Blast radius">
        <div
          onMouseEnter={() => setImpactPreview(node.id)}
          onMouseLeave={() => setImpactPreview(undefined)}
          className="group cursor-default rounded-xl border border-dashed border-line-2 p-3 transition-colors hover:border-bad/50 hover:bg-bad-soft/50"
        >
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            <Radar size={13} className="text-bad" />
            {blast.length ? <>Changing this touches <b className="dot text-[15px]">{blast.length}</b> other part{blast.length === 1 ? "" : "s"}</> : "Nothing else depends on this"}
          </div>
          {blast.length > 0 && (
            <>
              <div className="mt-2 flex flex-wrap gap-1">
                {blast.map((b) => (
                  <span key={b} className="inline-flex items-center gap-1 rounded-md bg-card px-1.5 py-0.5 text-[11px] text-ink-2 shadow-card">
                    <KindIcon kind={byId(b).kind} size={10} /> {byId(b).label}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-mute">Hover to see it on the canvas. Scoped prompts tell the agent to keep these working.</p>
            </>
          )}
        </div>
      </Section>

      {node.files.length > 0 && (
        <Section title={`Files · ${node.files.length}`}>
          <div className="-mx-1.5">
            {node.files.map((f) => {
              const info = ws.files[f];
              return (
                <button key={f} onClick={() => setOpenFile(f)} className="group flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-sunk">
                  <FileText size={12} className={info?.error ? "text-bad" : "text-faint"} />
                  <span className={cn("min-w-0 flex-1 truncate font-mono text-[11.5px]", info?.error ? "text-bad" : "text-ink-2")}>{f}</span>
                  {info?.lastAt && <span className="font-mono text-[10px] text-faint">{timeAgo(info.lastAt)}</span>}
                </button>
              );
            })}
          </div>
        </Section>
      )}
    </>
  );
}

function ConnRow({ node, dir, label, onClick }: { node: Component; dir: "in" | "out"; label?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-sunk">
      {dir === "in" ? <ArrowLeft size={12} className="text-faint" /> : <ArrowRight size={12} className="text-faint" />}
      <KindIcon kind={node.kind} size={13} />
      <span className="flex-1 truncate text-[12.5px]">{node.label}</span>
      <span className="font-mono text-[10px] text-faint">{dir === "in" ? `${label ?? "uses"} this` : label}</span>
    </button>
  );
}

function Activity({ node, runs }: { node: Component; runs: ReturnType<typeof useModel>["runs"] }) {
  const items = useMemo(() => {
    const out: { runPrompt: string; step: ReturnType<typeof stepsOf>[number] }[] = [];
    for (const r of [...runs].reverse()) {
      for (const s of stepsOf(r).reverse()) {
        const hit =
          node.files.some((f) => s.title.endsWith(` ${f}`) || s.title.includes(` ${f} `)) ||
          (node.kind === "runtime" && /process|logs|Started|Stopped/.test(s.title) && s.title.includes(node.id.replace("runtime:", ""))) ||
          (node.kind === "tests" && s.tool === "run_command" && /pytest|test|curl/.test(s.title));
        if (hit) out.push({ runPrompt: r.prompt, step: s });
      }
    }
    return out.slice(0, 60);
  }, [runs, node]);
  if (!items.length) return <Empty title="No activity yet">Steps the agent takes on this component show up here.</Empty>;
  return (
    <div className="p-2">
      {items.map(({ step, runPrompt }) => (
        <div key={step.id} title={runPrompt}>
          <StepRow step={step} />
        </div>
      ))}
    </div>
  );
}

function Footer({ node }: { node: Component }) {
  const setDraft = useStore((s) => s.setDraft);
  return (
    <footer className="border-t border-line bg-paper/60 px-4 py-3">
      <div className="mb-2 flex flex-wrap gap-1.5">
        {SUGGEST[node.kind].map((s) => (
          <button
            key={s}
            onClick={() => setDraft(s, node.id)}
            className="rounded-full border border-line bg-card px-2.5 py-1 text-[11px] text-ink-2 transition-colors hover:border-ink hover:text-ink"
          >
            {s}
          </button>
        ))}
      </div>
      <Button variant="primary" size="sm" className="w-full" onClick={() => setDraft("", node.id)}>
        Ask the agent to change {node.label}
      </Button>
    </footer>
  );
}
