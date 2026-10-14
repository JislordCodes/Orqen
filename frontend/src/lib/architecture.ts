import type { Architecture, Component, Finding, Kind, NodeHealth, Run, Wire, Workspace } from "./types";

/**
 * Turns the workspace (files, processes, installs) into an architecture graph.
 * Deterministic and instant: the canvas redraws on every tool event, so you watch
 * the system take shape while the agent writes it.
 */

const TESTS = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i;
const CONFIG = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|setup\.(py|cfg)|tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s|\.env[^/]*|dockerfile|docker-compose[^/]*\.ya?ml|\.gitignore|readme[^/]*|procfile|makefile|\.eslintrc[^/]*|\.prettierrc[^/]*|license[^/]*)$/i;
const AUTH = /(auth|login|logout|signup|register|session|jwt|oauth|passport|guard|permission|middleware)/i;
const DATA = /(^|\/)(models?|schema|db|database|prisma|migrations?|entities|repositor(y|ies)|seeds?|orm)(\/|\.|$)|\.(sql|prisma|sqlite3?|db)$/i;
const API = /(^|\/)(api|routes?|routers?|controllers?|handlers?|endpoints?|resolvers?)(\/|\.|$)|(^|\/)(app|main|server|wsgi|asgi|views)\.py$|(^|\/)(server|app|index)\.[cm]?[jt]s$|(^|\/)(backend|server)\/[^/]+\.[cm]?[jt]s$|route\.[jt]s$/i;
const UI = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro)$|(^|\/)(components?|pages?|views?|templates|static|public|layouts?|app|client|web|frontend|ui|hooks|styles)\//i;
const CODE = /\.(py|[cm]?[jt]sx?|go|rb|rs|java|kt|php)$/i;

export function classify(path: string): Kind {
  if (TESTS.test(path)) return "tests";
  if (CONFIG.test(path)) return "config";
  if (AUTH.test(path)) return "auth";
  if (DATA.test(path)) return "data";
  // A .tsx/.jsx under api/ is still an API route (Next.js), so check API before UI for those.
  if (API.test(path) && !/\.(html?|css|scss|vue|svelte)$/i.test(path) && !/(^|\/)(components?|pages?|hooks)\//i.test(path)) return "api";
  if (UI.test(path)) return "interface";
  if (CODE.test(path)) return "logic";
  return "config";
}

/** Third-party services worth their own node. Keys are package names from installs. */
const INTEGRATIONS: Record<string, { id: string; label: string; blurb: string }> = {
  stripe: { id: "stripe", label: "Stripe", blurb: "Payments" },
  openai: { id: "openai", label: "OpenAI", blurb: "LLM calls" },
  anthropic: { id: "anthropic", label: "Anthropic", blurb: "LLM calls" },
  "@anthropic-ai/sdk": { id: "anthropic", label: "Anthropic", blurb: "LLM calls" },
  resend: { id: "resend", label: "Resend", blurb: "Transactional email" },
  sendgrid: { id: "sendgrid", label: "SendGrid", blurb: "Email" },
  "@sendgrid/mail": { id: "sendgrid", label: "SendGrid", blurb: "Email" },
  nodemailer: { id: "smtp", label: "SMTP mail", blurb: "Email" },
  twilio: { id: "twilio", label: "Twilio", blurb: "SMS" },
  "@supabase/supabase-js": { id: "supabase", label: "Supabase", blurb: "Hosted Postgres + auth" },
  supabase: { id: "supabase", label: "Supabase", blurb: "Hosted Postgres + auth" },
  firebase: { id: "firebase", label: "Firebase", blurb: "Hosted backend" },
  "firebase-admin": { id: "firebase", label: "Firebase", blurb: "Hosted backend" },
  redis: { id: "redis", label: "Redis", blurb: "Cache / queue" },
  ioredis: { id: "redis", label: "Redis", blurb: "Cache / queue" },
  boto3: { id: "aws", label: "AWS", blurb: "Cloud services" },
  "aws-sdk": { id: "aws", label: "AWS", blurb: "Cloud services" },
  "@aws-sdk/client-s3": { id: "aws", label: "AWS S3", blurb: "File storage" },
  cloudinary: { id: "cloudinary", label: "Cloudinary", blurb: "Media storage" },
};

const DB_HINTS: [RegExp, string][] = [
  [/^(psycopg2?(-binary)?|pg|asyncpg|postgres)$/, "Postgres"],
  [/^(prisma|@prisma\/client)$/, "Prisma"],
  [/^(sqlalchemy|flask-sqlalchemy)$/, "SQLAlchemy"],
  [/^(mongoose|mongodb|pymongo)$/, "MongoDB"],
  [/^(better-sqlite3|sqlite3)$/, "SQLite"],
  [/^(drizzle-orm)$/, "Drizzle"],
];
const API_HINTS: [RegExp, string][] = [
  [/^fastapi$/, "FastAPI"],
  [/^flask$/, "Flask"],
  [/^express$/, "Express"],
  [/^next$/, "Next.js"],
  [/^django$/, "Django"],
  [/^hono$/, "Hono"],
];
const UI_HINTS: [RegExp, string][] = [
  [/^next$/, "Next.js"],
  [/^react$/, "React"],
  [/^vue$/, "Vue"],
  [/^svelte$/, "Svelte"],
  [/^tailwindcss$/, "Tailwind"],
];
const hint = (pkgs: string[], table: [RegExp, string][]) => {
  const found = new Set<string>();
  for (const p of pkgs) for (const [re, label] of table) if (re.test(p)) found.add(label);
  return [...found].join(" · ");
};

export const KIND_META: Record<Kind, { label: string; blurb: string; order: number }> = {
  runtime: { label: "Runtime", blurb: "The live server you preview", order: 0 },
  interface: { label: "Interface", blurb: "What people see and click", order: 1 },
  api: { label: "API", blurb: "Endpoints the interface calls", order: 2 },
  auth: { label: "Auth", blurb: "Decides who can do what", order: 3 },
  logic: { label: "Logic", blurb: "Business rules and helpers", order: 4 },
  data: { label: "Data", blurb: "Where records are stored", order: 5 },
  integration: { label: "Integration", blurb: "Third-party service", order: 6 },
  tests: { label: "Tests", blurb: "Proves the main flows work", order: 7 },
  config: { label: "Setup", blurb: "Dependencies, env and docs", order: 8 },
};

export function buildArchitecture(ws: Workspace, runs: Run[]): Architecture {
  const byKind: Partial<Record<Kind, string[]>> = {};
  for (const path of Object.keys(ws.files).sort()) (byKind[classify(path)] ??= []).push(path);

  const nodes: Component[] = [];
  const add = (c: Component) => nodes.push(c);
  const has = (id: string) => nodes.some((n) => n.id === id);

  for (const proc of Object.values(ws.processes)) {
    add({
      id: `runtime:${proc.name}`,
      kind: "runtime",
      label: proc.name === "web" ? "Web server" : proc.name,
      blurb: proc.running ? "Running · port 3000" : "Stopped",
      files: [],
      meta: { command: proc.cmd, status: proc.running ? "running" : "stopped" },
    });
  }
  const kinds: Kind[] = ["interface", "api", "auth", "logic", "data", "tests", "config"];
  for (const k of kinds) {
    const files = byKind[k];
    if (!files?.length) continue;
    const stack =
      k === "interface" ? hint(ws.packages, UI_HINTS) || stackFromFiles(files, "ui")
      : k === "api" ? hint(ws.packages, API_HINTS) || stackFromFiles(files, "api")
      : k === "data" ? hint(ws.packages, DB_HINTS)
      : "";
    add({ id: k, kind: k, label: KIND_META[k].label, blurb: KIND_META[k].blurb, files, meta: stack ? { stack } : undefined });
  }
  const seenInt = new Set<string>();
  for (const pkg of ws.packages) {
    const i = INTEGRATIONS[pkg];
    if (!i || seenInt.has(i.id)) continue;
    seenInt.add(i.id);
    const files = Object.values(ws.files)
      .filter((f) => f.content?.toLowerCase().includes(i.id) || f.path.toLowerCase().includes(i.id) || (i.id === "stripe" && /billing|payment|checkout/i.test(f.path)))
      .map((f) => f.path);
    add({ id: `int:${i.id}`, kind: "integration", label: i.label, blurb: i.blurb, files, meta: { package: pkg } });
  }

  /* ---- wires: from = caller, to = the thing it depends on ---- */
  const wires: Wire[] = [];
  const wire = (from: string, to: string, label: string, dashed = false) => {
    if (has(from) && has(to) && from !== to) wires.push({ id: `${from}->${to}`, from, to, label, dashed });
  };
  const first = (...ids: string[]) => ids.find(has);

  for (const r of nodes.filter((n) => n.kind === "runtime")) wire(r.id, first("interface", "api") ?? "", "serves");
  wire("interface", first("api", "logic", "data") ?? "", "HTTP");
  wire("api", "auth", "checks");
  wire("api", first("logic", "data") ?? "", "calls");
  wire("logic", "data", "reads · writes");
  wire("auth", "data", "users");
  for (const n of nodes.filter((n) => n.kind === "integration")) wire(first("logic", "api", "interface") ?? "", n.id, "SDK");
  wire("tests", first("api", "logic", "interface") ?? "", "verifies", true);

  return { nodes, wires, findings: findingsFor(nodes, ws, runs) };
}

function stackFromFiles(files: string[], k: "ui" | "api") {
  if (k === "ui") return files.some((f) => /\.(t|j)sx$/.test(f)) ? "React" : files.some((f) => /\.html?$/.test(f)) ? "HTML" : "";
  return files.some((f) => f.endsWith(".py")) ? "Python" : files.some((f) => /\.[cm]?[jt]s$/.test(f)) ? "Node" : "";
}

/* ------------------------------------------------------------------
 * Guardrails. Each rule is cheap, explainable, and comes with the exact
 * prompt that asks the agent to fix it.
 * ------------------------------------------------------------------ */
function findingsFor(nodes: Component[], ws: Workspace, runs: Run[]): Finding[] {
  const out: Finding[] = [];
  const has = (k: Kind | string) => nodes.some((n) => n.id === k || n.kind === k);
  const files = Object.values(ws.files);
  if (!files.length) return out;
  const anyFile = (re: RegExp) => files.some((f) => re.test(f.path));

  // 1. Edit failures on a component
  for (const f of files.filter((f) => f.error)) {
    const n = nodes.find((n) => n.files.includes(f.path));
    out.push({
      id: `err:${f.path}`,
      severity: "critical",
      title: `${f.path} is broken`,
      detail: firstLine(f.error!) || "The last change to this file failed.",
      nodeIds: n ? [n.id] : [],
      fixPrompt: `The last change to ${f.path} failed with this error:\n${f.error!.slice(0, 500)}\nFind the cause, fix it, verify it, and checkpoint.`,
    });
  }

  // 2. Failing tests (latest test command decides)
  const tests = ws.commands.filter((c) => c.kind === "test");
  const lastTest = tests[tests.length - 1];
  if (lastTest && lastTest.exit !== undefined && lastTest.exit !== 0) {
    out.push({
      id: "tests-failing",
      severity: "critical",
      title: "Tests are failing",
      detail: `\`${lastTest.cmd}\` exited with ${lastTest.exit}.`,
      nodeIds: ["tests"].filter(has),
      fixPrompt: `\`${lastTest.cmd}\` is failing. Read the failure, fix the code (not the test, unless the test is wrong), re-run it until it passes, then checkpoint.`,
    });
  }

  // 3. No auth in front of an API
  if (has("api") && !has("auth")) {
    out.push({
      id: "no-auth",
      severity: "warning",
      title: "API has no auth boundary",
      detail: "Every endpoint is public. Anyone can create, change or delete data.",
      nodeIds: ["api"],
      fixPrompt: "Add authentication. Keep read-only public endpoints public, require a signed-in user for every endpoint that creates, changes or deletes data, put the auth code in its own module, add tests for both allowed and rejected requests, and checkpoint.",
    });
  }

  // 4. Nothing tested
  if ((has("api") || has("logic")) && !has("tests") && !tests.length) {
    out.push({
      id: "no-tests",
      severity: "warning",
      title: "Nothing is tested",
      detail: "There are no tests, so a change can break the app silently.",
      nodeIds: ["api", "logic"].filter(has),
      fixPrompt: "Write automated tests for the main flows (create, read, update, delete through the real endpoints), run them, fix anything that fails, and checkpoint.",
    });
  }

  // 5. Secrets without .env.example
  const integrations = nodes.filter((n) => n.kind === "integration");
  if (integrations.length && !anyFile(/(^|\/)\.env\.example$/)) {
    out.push({
      id: "no-env",
      severity: "critical",
      title: "Secrets have no home",
      detail: `${integrations.map((i) => i.label).join(", ")} need keys, but there's no .env.example.`,
      nodeIds: integrations.map((i) => i.id),
      fixPrompt: "Make sure no API keys are in the code. Read every secret from environment variables, document each one in .env.example, add .env to .gitignore, and checkpoint.",
    });
  }

  // 6. Content rules (only for files whose text we've seen)
  for (const f of files.filter((f) => f.content)) {
    const n = nodes.find((n) => n.files.includes(f.path));
    const ids = n ? [n.id] : [];
    if (/debug\s*=\s*True/.test(f.content!)) {
      out.push({ id: `debug:${f.path}`, severity: "critical", title: "Debug mode is on", detail: `${f.path} runs the server with debug=True.`, nodeIds: ids, fixPrompt: `Turn off debug mode in ${f.path}; read it from an environment variable that defaults to off. Restart the web process and checkpoint.` });
    }
    if (/(sk_live_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_\-]{16,})/.test(f.content!)) {
      out.push({ id: `secret:${f.path}`, severity: "critical", title: "Hard-coded secret", detail: `${f.path} contains what looks like a live key.`, nodeIds: ids, fixPrompt: `Remove the hard-coded secret from ${f.path}, read it from an environment variable instead, document it in .env.example, and checkpoint.` });
    }
    if (n?.kind === "interface" && /https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(f.content!)) {
      out.push({ id: `localhost:${f.path}`, severity: "warning", title: "Hard-coded localhost URL", detail: `${f.path} calls localhost, which breaks in the preview.`, nodeIds: ids, fixPrompt: `Replace hard-coded localhost URLs in ${f.path} with relative URLs, and checkpoint.` });
    }
  }

  // 7. Preview server
  const web = ws.processes.web;
  if ((has("interface") || has("api")) && (!web || !web.running)) {
    const busy = runs.some((r) => r.status === "running");
    if (!busy) {
      out.push({
        id: "no-preview",
        severity: "warning",
        title: web ? "Preview server stopped" : "Nothing is serving the app",
        detail: "The preview needs a process named “web” listening on 0.0.0.0:3000.",
        nodeIds: web ? ["runtime:web"] : ["interface", "api"].filter(has).slice(0, 1),
        fixPrompt: "Start the app with start_process named \"web\" listening on 0.0.0.0 port 3000, check its logs until it's healthy, and tell me when it's up.",
      });
    }
  }

  // 8. Hygiene
  if (!anyFile(/(^|\/)\.gitignore$/)) {
    out.push({ id: "no-gitignore", severity: "info", title: "No .gitignore", detail: "node_modules, .env or build output could end up in Git.", nodeIds: ["config"].filter(has), fixPrompt: "Add a .gitignore that covers node_modules, .env, virtualenvs, caches and build output, and checkpoint." });
  }
  if (!anyFile(/(^|\/)readme[^/]*$/i)) {
    out.push({ id: "no-readme", severity: "info", title: "No README", detail: "Nobody can run this after export to GitHub.", nodeIds: ["config"].filter(has), fixPrompt: "Write a README: what the app does, how to install, run and test it, and every environment variable. Then checkpoint." });
  }
  return out;
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim() && !/^exit=/.test(l))?.trim().slice(0, 140) ?? "";

/* ------------------------------------------------------------------
 * Blast radius: who depends on this node, transitively.
 * ------------------------------------------------------------------ */
export function dependentsOf(id: string, wires: Wire[]): string[] {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const w of wires) if (w.to === cur && w.from !== id && !out.has(w.from)) {
      out.add(w.from);
      queue.push(w.from);
    }
  }
  return [...out];
}

export function dependenciesOf(id: string, wires: Wire[]) {
  return wires.filter((w) => w.from === id).map((w) => w.to);
}

export function healthOf(node: Component, arch: Architecture, ws: Workspace, broken: Set<string>): NodeHealth {
  if (broken.has(node.id)) return "broken";
  const working = node.files.some((f) => ws.activeFiles.has(f));
  if (working) return "working";
  const mine = arch.findings.filter((f) => f.nodeIds.includes(node.id));
  if (mine.some((f) => f.severity === "critical")) return "broken";
  if (mine.some((f) => f.severity === "warning")) return "warn";
  if (node.kind === "runtime") return node.meta?.status === "running" ? "ok" : "warn";
  return node.files.length ? "ok" : "idle";
}

/**
 * Nodes to paint red: anything with a critical finding, plus, while the latest
 * tests are failing after a scoped run, everything that depends on the scoped node.
 */
export function brokenSet(arch: Architecture, runs: Run[]): Set<string> {
  const s = new Set<string>();
  for (const f of arch.findings) if (f.severity === "critical") f.nodeIds.forEach((id) => s.add(id));
  if (arch.findings.some((f) => f.id === "tests-failing")) {
    const last = [...runs].sort((a, b) => b.startedAt - a.startedAt)[0];
    if (last?.scope) {
      s.add(last.scope.nodeId);
      dependentsOf(last.scope.nodeId, arch.wires).forEach((id) => s.add(id));
    }
  }
  return s;
}

/** The prompt actually sent for a node-scoped request. */
export function scopedPrompt(node: Component, request: string, arch: Architecture): string {
  const dependents = dependentsOf(node.id, arch.wires).map((id) => arch.nodes.find((n) => n.id === id)!).filter(Boolean);
  const lines = [
    `[Scope: ${node.label}${node.files.length ? "" : " (new)"}]`,
    node.files.length ? `Only change these files unless it's strictly necessary: ${node.files.join(", ")}.` : `This is a new ${KIND_META[node.kind].label.toLowerCase()} component; keep it in its own module.`,
  ];
  if (dependents.length) {
    lines.push(`These parts depend on it and must keep working: ${dependents.map((d) => `${d.label}${d.files.length ? ` (${d.files.slice(0, 4).join(", ")})` : ""}`).join("; ")}.`);
    lines.push("If you change a contract (function signature, endpoint, payload or schema), update every caller in the same run.");
  }
  lines.push("Verify the change (build, tests or curl), then checkpoint.", "", `Request: ${request}`);
  return lines.join("\n");
}
