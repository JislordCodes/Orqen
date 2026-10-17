import type { CommandInfo, Run, RunEvent, Workspace } from "./types";

/**
 * Replays every run's event stream, in order, into a picture of the sandbox:
 * which files exist, which processes run, which commands passed or failed.
 * The backend has no file-tree endpoint yet, so the stream IS our source of truth.
 */

const IGNORE = /(^|\/)(node_modules|\.git|dist|build|__pycache__|\.venv|\.next)(\/|$)|\.(lock|pyc)$|package-lock\.json$/;

export function normalizePath(p: unknown): string | null {
  if (typeof p !== "string" || !p.trim()) return null;
  let s = p.trim().replace(/^\/workspace\/?/, "").replace(/^\.\//, "");
  if (!s || s === ".") return null;
  if (IGNORE.test(s)) return null;
  return s;
}

export function commandKind(cmd: string): CommandInfo["kind"] {
  if (/\b(pytest|vitest|jest|mocha|npm (run )?test|pnpm test|yarn test|unittest|curl\b.*(-X|--request|localhost|127\.0\.0\.1|0\.0\.0\.0))/.test(cmd)) return "test";
  if (/\b(pip3? install|npm (i|install|add)|pnpm (i|install|add)|yarn add|poetry add|uv (pip|add))\b/.test(cmd)) return "install";
  if (/\b(npm run build|vite build|tsc|next build|python -m py_compile|ruff|eslint|mypy)\b/.test(cmd)) return "build";
  if (/^\s*git\b/.test(cmd)) return "git";
  return "other";
}

export function parseExit(output: string | undefined): number | undefined {
  const m = output?.match(/^exit=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** Package names from an install command, e.g. "pip install flask stripe==7" -> [flask, stripe]. */
export function packagesFrom(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of cmd.split(/&&|;|\|\|/)) {
    const m = seg.match(/\b(?:pip3? install|npm (?:i|install|add)|pnpm (?:i|install|add)|yarn add|poetry add|uv (?:pip install|add))\s+(.+)/);
    if (!m) continue;
    for (const tok of m[1].split(/\s+/)) {
      if (!tok || tok.startsWith("-") || tok.includes("/") && !tok.startsWith("@")) continue;
      const name = tok.replace(/(==|>=|<=|~=|@\^|@~|@\d).*$/, "").replace(/^['"]|['"]$/g, "").toLowerCase();
      if (name && !name.endsWith(".txt") && name !== "." ) out.push(name);
    }
  }
  return out;
}

/** view_file returns "[path: lines a-b of n]\n1\tline…". Strip it back to the source text. */
export function parseViewFile(output: string): { path: string; content: string; complete: boolean } | null {
  const head = output.match(/^\[(.+?): lines (\d+)-(\d+) of (\d+)\]\n/);
  if (!head) return null;
  const body = output.slice(head[0].length).split("\n").map((l) => l.replace(/^\d+\t/, "")).join("\n");
  const complete = head[2] === "1" && head[3] === head[4] && !output.includes("[output truncated]");
  return { path: head[1], content: body, complete };
}

function pathsIn(text: string, known: Set<string>): string[] {
  const hits: string[] = [];
  known.forEach((p) => text.includes(p) && hits.push(p));
  return hits;
}

export function buildWorkspace(runs: Run[], liveRunId?: string): Workspace {
  const ws: Workspace = { files: {}, processes: {}, commands: [], packages: [], checkpoints: [], activeFiles: new Set() };
  const pkgs = new Set<string>();

  const touch = (path: string, run: Run, at: number, patch: Partial<Workspace["files"][string]> = {}) => {
    const f = (ws.files[path] ??= { path, edits: 0, createdBy: run.id });
    Object.assign(f, { lastRunId: run.id, lastAt: at, error: undefined }, patch);
    if (run.id === liveRunId) ws.activeFiles.add(path);
  };

  const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  for (const run of sorted) {
    // Pair each tool_result with its tool_start (FIFO per tool name; tools may overlap).
    const pending: Record<string, RunEvent[]> = {};
    for (const ev of run.events) {
      if (ev.type === "tool_start") {
        (pending[ev.data.name] ??= []).push(ev);
        const input = ev.data.input ?? {};
        if (ev.data.name === "create_file" || ev.data.name === "str_replace") {
          const p = normalizePath(input.path);
          if (p && run.id === liveRunId) ws.activeFiles.add(p);
        }
        continue;
      }
      if (ev.type !== "tool_result") continue;
      const start = pending[ev.data.name]?.shift();
      const input = (start?.type === "tool_start" ? start.data.input : {}) as Record<string, unknown>;
      const out = ev.data.output ?? "";
      const failed = out.startsWith("ERROR");

      switch (ev.data.name) {
        case "create_file": {
          const p = normalizePath(input.path);
          if (!p || p.startsWith(".orqen/")) break; // harness plan files are not part of the system
          if (failed) touch(p, run, ev.at, { error: out });
          else touch(p, run, ev.at, { chars: Number(input.chars) || undefined, edits: (ws.files[p]?.edits ?? 0) + 1, content: undefined });
          break;
        }
        case "str_replace": {
          const p = normalizePath(input.path);
          if (!p || p.startsWith(".orqen/")) break; // harness plan files are not part of the system
          if (failed) touch(p, run, ev.at, { error: out });
          else touch(p, run, ev.at, { edits: (ws.files[p]?.edits ?? 0) + 1, content: undefined });
          break;
        }
        case "view_file": {
          const v = parseViewFile(out);
          const p = normalizePath(v?.path ?? input.path);
          if (!p) break;
          const f = (ws.files[p] ??= { path: p, edits: 0 });
          if (v?.complete) f.content = v.content;
          if (failed) f.error = undefined; // a missing file isn't a broken one
          break;
        }
        case "list_dir": {
          for (const line of out.split("\n")) {
            const p = normalizePath(line);
            if (p && /\.[a-z0-9]+$/i.test(p) && !ws.files[p]) ws.files[p] = { path: p, edits: 0 };
          }
          break;
        }
        case "run_command": {
          const cmd = String(input.cmd ?? "");
          const exit = parseExit(out);
          const kind = commandKind(cmd);
          ws.commands.push({ id: `${run.id}:${ws.commands.length}`, cmd, exit, output: out, runId: run.id, at: ev.at, kind });
          if (kind === "install" && exit === 0) packagesFrom(cmd).forEach((n) => pkgs.add(n));
          // A green test run clears failures that earlier commands pinned on files.
          if (kind === "test" && exit === 0) for (const f of Object.values(ws.files)) if (f.error?.startsWith("exit=")) f.error = undefined;
          if (exit && exit !== 0) {
            // Attribute the failure to any known file the error output names.
            for (const p of pathsIn(out, new Set(Object.keys(ws.files)))) ws.files[p].error = out.slice(0, 600);
          }
          break;
        }
        case "start_process": {
          const name = String(input.name ?? "process");
          ws.processes[name] = { name, cmd: String(input.cmd ?? ""), running: !failed, lastLog: out, runId: run.id };
          break;
        }
        case "read_process_logs": {
          const name = String(input.name ?? "");
          const p = ws.processes[name];
          if (p) {
            p.running = /STATUS: running/.test(out);
            p.lastLog = out;
          }
          break;
        }
        case "stop_process": {
          const p = ws.processes[String(input.name ?? "")];
          if (p) p.running = false;
          break;
        }
        case "checkpoint": {
          if (!/nothing to commit/.test(out)) {
            ws.checkpoints.push({ message: String(input.message ?? ""), runId: run.id, at: ev.at, sha: out.trim().split(" ")[0]?.slice(0, 7) });
          }
          break;
        }
      }
    }
  }
  ws.packages = [...pkgs];
  return ws;
}

/* ---------------- human-readable step labels (Executions + chat) ---------------- */
export interface Step {
  id: string;
  tool: string;
  title: string;
  detail?: string;
  output?: string;
  state: "running" | "ok" | "fail";
  at: number;
  endAt?: number;
}

export function stepsOf(run: Run): Step[] {
  const steps: Step[] = [];
  const open: Record<string, Step[]> = {};
  for (const ev of run.events) {
    if (ev.type === "tool_start") {
      const i = ev.data.input ?? {};
      const s: Step = { id: ev.id, tool: ev.data.name, title: describe(ev.data.name, i), detail: detailOf(ev.data.name, i), state: "running", at: ev.at };
      steps.push(s);
      (open[ev.data.name] ??= []).push(s);
    } else if (ev.type === "tool_result") {
      const s = open[ev.data.name]?.shift();
      if (!s) continue;
      s.output = ev.data.output;
      s.endAt = ev.at;
      const exit = parseExit(ev.data.output);
      s.state = ev.data.output.startsWith("ERROR") || ev.data.output.startsWith("STOP") || ev.data.output.startsWith("BLOCKED") || ev.data.output.startsWith("FAIL") || (exit !== undefined && exit !== 0) ? "fail" : "ok";
    }
  }
  if (run.status !== "running") steps.forEach((s) => s.state === "running" && (s.state = "fail"));
  return steps;
}

function describe(tool: string, i: Record<string, unknown>): string {
  const p = String(i.path ?? ".");
  switch (tool) {
    case "list_dir": return `Looked around ${p === "." ? "the project" : p}`;
    case "view_file": return `Read ${p}`;
    case "grep": return `Searched for “${String(i.pattern ?? "")}”`;
    case "create_file": return `Wrote ${p}`;
    case "str_replace": return `Edited ${p}`;
    case "run_command": return `Ran ${String(i.cmd ?? "").split("\n")[0].slice(0, 80)}`;
    case "start_process": return `Started ${String(i.name ?? "process")}`;
    case "read_process_logs": return `Checked ${String(i.name ?? "process")} logs`;
    case "stop_process": return `Stopped ${String(i.name ?? "process")}`;
    case "checkpoint": return `Checkpoint · ${String(i.message ?? "")}`;
    case "submit_plan": return "Sent the plan for your approval";
    case "list_features": return "Checked the feature list";
    case "run_checks": return "Ran the quality gates";
    case "mark_feature": return `${i.passes ? "Verified" : "Flagged"} ${String(i.id ?? "feature")}`;
    case "add_feature": return `Added feature · ${String(i.title ?? "")}`;
    case "update_progress": return "Wrote hand-off notes";
    default: return tool;
  }
}
function detailOf(tool: string, i: Record<string, unknown>): string | undefined {
  if (tool === "create_file" && i.chars) return `${Number(i.chars).toLocaleString()} chars`;
  if (tool === "start_process") return String(i.cmd ?? "");
  return undefined;
}

/** Agent prose for a run, joined. */
export function textOf(run: Run) {
  return run.events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.data.text : "")).join("");
}

/** Interleaved agent text and tool steps, in the order they happened. */
export type TimelineItem = { kind: "text"; id: string; text: string } | { kind: "step"; step: Step };

export function timelineOf(run: Run): TimelineItem[] {
  const steps = stepsOf(run);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const items: TimelineItem[] = [];
  for (const ev of run.events) {
    if (ev.type === "text") {
      const last = items[items.length - 1];
      if (last?.kind === "text") last.text += ev.data.text;
      else items.push({ kind: "text", id: ev.id, text: ev.data.text });
    } else if (ev.type === "tool_start") {
      const s = byId.get(ev.id);
      if (s) items.push({ kind: "step", step: s });
    }
  }
  return items;
}
