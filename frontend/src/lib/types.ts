/* ------------------------------------------------------------------
 * Wire types: exactly what backend/app/api.py + events.py send.
 * ------------------------------------------------------------------ */
export type ServerEvent =
  | { type: "status"; data: { state: string } }
  | { type: "text"; data: { text: string } }
  | { type: "tool_start"; data: { name: ToolName | string; input: Record<string, unknown> } }
  | { type: "tool_result"; data: { name: ToolName | string; output: string } }
  | { type: "done"; data: { summary: string } }
  | { type: "error"; data: { message: string } };

/** The ten tools in backend/app/tools.py */
export type ToolName =
  | "list_dir"
  | "view_file"
  | "grep"
  | "create_file"
  | "str_replace"
  | "run_command"
  | "start_process"
  | "read_process_logs"
  | "stop_process"
  | "checkpoint";

/** A server event as we keep it: with the SSE id and the time we received it. */
export type RunEvent = ServerEvent & { id: string; at: number };

export type RunStatus = "queued" | "running" | "done" | "error";

export interface Run {
  id: string;
  projectId: string;
  prompt: string;
  /** If the run was started from a node, the component it was scoped to. */
  scope?: { nodeId: string; label: string; files: string[]; impacted: string[] };
  /** What kind of run this was, for the Executions list. */
  intent: "build" | "scoped" | "fix" | "audit" | "test";
  status: RunStatus;
  events: RunEvent[];
  startedAt: number;
  endedAt?: number;
  summary?: string;
  error?: string;
}

export interface Project {
  id: string; // slug: ^[a-z0-9][a-z0-9-]{0,29}$ (backend check_project)
  name: string;
  createdAt: number;
}

/* ------------------------------------------------------------------
 * Derived model: what we know about the workspace from the event stream.
 * ------------------------------------------------------------------ */
export interface FileInfo {
  path: string;
  chars?: number;
  content?: string; // from view_file output, the files endpoint, or demo
  createdBy?: string; // run id
  lastRunId?: string;
  lastAt?: number;
  edits: number;
  error?: string; // last tool error that mentioned this file
}

export interface ProcessInfo {
  name: string;
  cmd: string;
  running: boolean;
  lastLog?: string;
  runId: string;
}

export interface CommandInfo {
  id: string;
  cmd: string;
  exit?: number;
  output?: string;
  runId: string;
  at: number;
  kind: "install" | "test" | "build" | "git" | "other";
}

export interface Workspace {
  files: Record<string, FileInfo>;
  processes: Record<string, ProcessInfo>;
  commands: CommandInfo[];
  packages: string[];
  checkpoints: { message: string; runId: string; at: number; sha?: string }[];
  /** Files touched by the run that is live right now. */
  activeFiles: Set<string>;
}

/* ------------------------------------------------------------------
 * Canvas model
 * ------------------------------------------------------------------ */
export type Kind =
  | "interface" // UI: pages, components, templates
  | "api" // routes, handlers, server entry
  | "auth" // auth, sessions, guards
  | "logic" // services, lib, utils
  | "data" // models, schema, db, migrations
  | "integration" // third-party SDKs from installs (stripe, openai…)
  | "runtime" // long-running processes (the preview server)
  | "tests"
  | "config"; // package.json, env, docker, README

export type NodeHealth = "idle" | "working" | "ok" | "warn" | "broken";

export interface Component {
  id: string;
  kind: Kind;
  label: string;
  /** One-line plain-English description, for semi-technical builders. */
  blurb: string;
  files: string[];
  meta?: Record<string, string>;
}

export interface Wire {
  id: string;
  from: string; // depends on ↓
  to: string;
  label: string;
  dashed?: boolean;
}

export type Severity = "critical" | "warning" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  nodeIds: string[];
  /** Prompt that asks the agent to fix it. */
  fixPrompt: string;
}

export interface Architecture {
  nodes: Component[];
  wires: Wire[];
  findings: Finding[];
}
