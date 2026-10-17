import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, ApiError, type Connection } from "@/lib/api";
import { buildArchitecture, dependentsOf, scopedPrompt } from "@/lib/architecture";
import { buildWorkspace } from "@/lib/workspace";
import { modeForPrompt } from "@/lib/plan";
import type { Project, Run, ServerEvent } from "@/lib/types";
import { slugify, uid } from "@/lib/utils";
import { runDemo } from "@/demo/engine";
import { PREVIEW_HTML } from "@/demo/files";

export type Tab = "editor" | "executions" | "tests";
export type InspectorTab = "overview" | "code" | "activity";
type Mode = "live" | "demo";

interface Toast { id: string; text: string; tone: "info" | "error" | "ok" }

interface State {
  conn: Connection;
  mode: Mode;
  health: "unknown" | "ok" | "down";

  projects: Project[];
  projectId: string;
  runs: Record<string, Run[]>;
  /** File text we know, per project (demo writes, files endpoint, view_file captures). */
  contents: Record<string, Record<string, string>>;
  /** File list from the optional GET /projects/{id}/files endpoint. */
  trees: Record<string, string[]>;

  tab: Tab;
  selectedNodeId?: string;
  impactPreviewId?: string; // hover "what breaks if I change this?"
  selectedRunId?: string;
  inspectorTab: InspectorTab;
  openFile?: string;
  chatOpen: boolean;
  /** Chat input text, so the canvas can prefill it ("add a step between…"). */
  draft: string;
  draftScope?: string;
  focusTick: number;
  preview: { open: boolean; url?: string; html?: string; error?: string; loading: boolean };
  settingsOpen: boolean;
  newProjectOpen: boolean;
  toasts: Toast[];

  // actions
  setConn: (c: Partial<Connection>) => void;
  setMode: (m: Mode) => void;
  checkHealth: () => Promise<void>;
  createProject: (name: string) => void;
  switchProject: (id: string) => void;
  deleteProject: (id: string) => void;
  setTab: (t: Tab) => void;
  select: (nodeId?: string) => void;
  setImpactPreview: (id?: string) => void;
  setInspectorTab: (t: InspectorTab) => void;
  setOpenFile: (p?: string) => void;
  selectRun: (id?: string) => void;
  setChatOpen: (o: boolean) => void;
  setDraft: (text: string, scopeNodeId?: string | null) => void;
  send: (request: string, opts?: { scopeNodeId?: string; intent?: Run["intent"]; mode?: Run["mode"] }) => Promise<void>;
  /** Approve the plan on screen: starts the feature-by-feature build. */
  approvePlan: () => Promise<void>;
  openPreview: () => Promise<void>;
  closePreview: () => void;
  loadFile: (path: string) => Promise<void>;
  syncTree: () => Promise<void>;
  importRepo: (url: string) => void;
  setSettingsOpen: (o: boolean) => void;
  setNewProjectOpen: (o: boolean) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
  dismissToast: (id: string) => void;
  resumeStreams: () => void;
}

const ENV_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
const ENV_USER = (import.meta.env.VITE_USER_ID as string | undefined) || "demo-user";
const streams = new Map<string, () => void>();

const FIRST: Project = { id: "main", name: "My first system", createdAt: Date.now() };

export const useStore = create<State>()(
  persist(
    (set, get) => {
      /** Immutable update of one run in the active project's list. */
      const patchRun = (projectId: string, runId: string, fn: (r: Run) => Run) =>
        set((s) => ({ runs: { ...s.runs, [projectId]: (s.runs[projectId] ?? []).map((r) => (r.id === runId ? fn(r) : r)) } }));

      const onEvent = (projectId: string, runId: string) => (e: ServerEvent, id: string) => {
        patchRun(projectId, runId, (r) => {
          const next: Run = { ...r, events: [...r.events, { ...e, id: id || `${r.events.length}`, at: Date.now() } as Run["events"][number]] };
          if (e.type === "status") next.status = "running";
          if (e.type === "done") Object.assign(next, { status: "done", summary: e.data.summary, endedAt: Date.now() });
          if (e.type === "error") Object.assign(next, { status: "error", error: e.data.message || "Run failed", endedAt: Date.now() });
          return next;
        });
        // Capture complete file text from view_file results so the code view can show it.
        if (e.type === "tool_result" && e.data.name === "view_file") {
          const m = e.data.output.match(/^\[(.+?): lines 1-(\d+) of (\d+)\]\n/);
          if (m && m[2] === m[3] && !e.data.output.includes("[output truncated]")) {
            const text = e.data.output.slice(m[0].length).split("\n").map((l) => l.replace(/^\d+\t/, "")).join("\n");
            set((s) => ({ contents: { ...s.contents, [projectId]: { ...(s.contents[projectId] ?? {}), [m[1].replace(/^\/workspace\/?/, "")]: text } } }));
          }
        }
        // In live mode, a write makes any text we captured earlier stale.
        if (e.type === "tool_result" && get().mode === "live" && (e.data.name === "create_file" || e.data.name === "str_replace")) {
          const m = e.data.output.match(/^(?:wrote|edited) (.+?)(?: \(\d+ chars\))?$/);
          if (m) {
            set((s) => {
              const cur = { ...(s.contents[projectId] ?? {}) };
              delete cur[m[1]];
              return { contents: { ...s.contents, [projectId]: cur } };
            });
          }
        }
        // A plan or the planner's questions need the user: keep the thread open so they see it.
        if (e.type === "plan") set({ chatOpen: true });
        if (e.type === "done" || e.type === "error") {
          streams.delete(runId);
          const s = get();
          if (e.type === "done") s.toast("Run finished", "ok");
          else s.toast(e.data.message || "Run failed", "error");
          if (s.preview.open) s.openPreview(); // refresh the preview after a run
          s.syncTree();
        }
      };

      // Public tunnels drop long SSE connections now and then. The server keeps every event in a
      // Redis Stream, so on a drop we open a fresh stream (it replays from the start) and rebuild.
      const subscribe = (projectId: string, runId: string, attempt = 0) => {
        const { conn } = get();
        const stop = api.streamRun(
          conn,
          runId,
          (e, id) => {
            attempt = 0; // events are flowing again
            onEvent(projectId, runId)(e, id);
          },
          (msg) => {
            streams.delete(runId);
            if (attempt < 10) {
              const t = setTimeout(() => {
                if (streams.get(runId) !== retryStop) return; // cancelled meanwhile
                patchRun(projectId, runId, (r) => ({ ...r, events: [], status: "running", error: undefined }));
                subscribe(projectId, runId, attempt + 1);
              }, 2000 + attempt * 1000);
              const retryStop = () => clearTimeout(t);
              streams.set(runId, retryStop);
              return;
            }
            get().toast(msg, "error");
            patchRun(projectId, runId, (r) => ({ ...r, status: "error", error: msg, endedAt: Date.now() }));
          },
        );
        streams.set(runId, stop);
      };

      return {
        conn: { baseUrl: ENV_URL || "http://localhost:8000", userId: ENV_USER },
        mode: ENV_URL ? "live" : "demo",
        health: "unknown",
        projects: [FIRST],
        projectId: FIRST.id,
        runs: {},
        contents: {},
        trees: {},
        tab: "editor",
        inspectorTab: "overview",
        chatOpen: true,
        draft: "",
        focusTick: 0,
        preview: { open: false, loading: false },
        settingsOpen: false,
        newProjectOpen: false,
        toasts: [],

        setConn: (c) => set((s) => ({ conn: { ...s.conn, ...c }, health: "unknown" })),
        setMode: (mode) => set({ mode }),
        async checkHealth() {
          if (get().mode === "demo") {
            set({ health: "ok" });
            return;
          }
          try {
            await api.health(get().conn);
            set({ health: "ok" });
          } catch {
            set({ health: "down" });
          }
        },

        createProject(name) {
          const base = slugify(name) || "project";
          let id = base;
          let n = 2;
          while (get().projects.some((p) => p.id === id)) id = `${base.slice(0, 27)}-${n++}`;
          const p: Project = { id, name: name.trim() || id, createdAt: Date.now() };
          set((s) => ({ projects: [...s.projects, p], projectId: id, selectedNodeId: undefined, selectedRunId: undefined, tab: "editor", newProjectOpen: false }));
        },
        switchProject(id) {
          set({ projectId: id, selectedNodeId: undefined, selectedRunId: undefined, openFile: undefined, preview: { open: false, loading: false } });
          get().syncTree();
        },
        deleteProject(id) {
          set((s) => {
            const projects = s.projects.filter((p) => p.id !== id);
            const { [id]: _r, ...runs } = s.runs;
            const { [id]: _c, ...contents } = s.contents;
            const list = projects.length ? projects : [{ ...FIRST, createdAt: Date.now() }];
            return { projects: list, runs, contents, projectId: s.projectId === id ? list[0].id : s.projectId };
          });
        },

        setTab: (tab) => set({ tab }),
        select: (selectedNodeId) => set((s) => ({ selectedNodeId, openFile: undefined, inspectorTab: selectedNodeId === s.selectedNodeId ? s.inspectorTab : "overview" })),
        setImpactPreview: (impactPreviewId) => set({ impactPreviewId }),
        setInspectorTab: (inspectorTab) => set({ inspectorTab }),
        setOpenFile: (openFile) => set({ openFile, inspectorTab: openFile ? "code" : get().inspectorTab }),
        selectRun: (selectedRunId) => set({ selectedRunId }),
        setChatOpen: (chatOpen) => set({ chatOpen }),
        setDraft: (draft, scope) =>
          set((s) => ({ draft, draftScope: scope === null ? undefined : scope ?? s.draftScope, focusTick: s.focusTick + 1, tab: "editor" })),

        async send(request, opts = {}) {
          const s = get();
          const projectId = s.projectId;
          const runs = s.runs[projectId] ?? [];
          if (runs.some((r) => r.status === "running" || r.status === "queued")) {
            s.toast("This project already has a run in progress. Only one at a time.", "error");
            return;
          }
          // Build the scoped prompt from the current architecture.
          const ws = buildWorkspace(runs);
          const arch = buildArchitecture(ws, runs);
          const node = opts.scopeNodeId ? arch.nodes.find((n) => n.id === opts.scopeNodeId) : undefined;
          const prompt = node ? scopedPrompt(node, request, arch) : request;
          const impacted = node ? dependentsOf(node.id, arch.wires) : [];
          const intent: Run["intent"] = opts.intent ?? (node ? "scoped" : "build");
          const mode: Run["mode"] = opts.mode ?? modeForPrompt(runs);

          const draft: Omit<Run, "id"> = {
            projectId,
            prompt: request,
            scope: node ? { nodeId: node.id, label: node.label, files: node.files, impacted } : undefined,
            intent,
            mode,
            status: "queued",
            events: [],
            startedAt: Date.now(),
          };

          if (s.mode === "demo") {
            const id = uid();
            set((st) => ({ runs: { ...st.runs, [projectId]: [...(st.runs[projectId] ?? []), { ...draft, id }] }, chatOpen: true }));
            const stop = runDemo(
              { prompt: request, scopeNodeId: node?.id, scopeFiles: node?.files ?? [], files: get().contents[projectId] ?? {}, mode },
              onEvent(projectId, id),
              (path, content) => set((st) => ({ contents: { ...st.contents, [projectId]: { ...(st.contents[projectId] ?? {}), [path]: content } } })),
            );
            streams.set(id, stop);
            return;
          }

          try {
            const { run_id } = await api.startRun(s.conn, prompt, projectId, mode);
            set((st) => ({ runs: { ...st.runs, [projectId]: [...(st.runs[projectId] ?? []), { ...draft, id: run_id }] }, chatOpen: true, health: "ok" }));
            subscribe(projectId, run_id);
          } catch (e) {
            const err = e as ApiError;
            if (err.status === 409) s.toast("The server says a run is already in progress for this project.", "error");
            else if (err.status === 0) {
              set({ health: "down" });
              s.toast(`${err.message} Switch to Demo mode in Settings to explore without a backend.`, "error");
            } else s.toast(err.message, "error");
          }
        },

        approvePlan: () => get().send("Approved. Build the plan, one feature at a time.", { mode: "build", intent: "build" }),

        async openPreview() {
          const s = get();
          if (s.mode === "demo") {
            const hasApp = Object.keys(s.contents[s.projectId] ?? {}).length > 0;
            set({ preview: hasApp ? { open: true, loading: false, html: PREVIEW_HTML, url: `https://${s.projectId}.preview.orqen.dev/` } : { open: true, loading: false, error: "Nothing is running yet. Describe an app and the agent will start it on port 3000." } });
            return;
          }
          set({ preview: { ...s.preview, open: true, loading: true, error: undefined } });
          try {
            const { url } = await api.preview(s.conn, s.projectId);
            set({ preview: { open: true, loading: false, url } });
          } catch (e) {
            const err = e as ApiError;
            set({
              preview: {
                open: true,
                loading: false,
                error: err.status === 501 ? "The server has no PREVIEW_DOMAIN set. Add one to backend/.env (for example <your-ip>.nip.io) and restart the API." : err.message,
              },
            });
          }
        },
        closePreview: () => set((s) => ({ preview: { ...s.preview, open: false } })),

        async loadFile(path) {
          const s = get();
          if (s.mode === "demo" || s.contents[s.projectId]?.[path] !== undefined) return;
          const text = await api.fileContent(s.conn, s.projectId, path);
          if (text !== null) set((st) => ({ contents: { ...st.contents, [s.projectId]: { ...(st.contents[s.projectId] ?? {}), [path]: text } } }));
        },

        async syncTree() {
          const s = get();
          if (s.mode !== "live") return;
          const files = await api.fileTree(s.conn, s.projectId);
          if (files) set((st) => ({ trees: { ...st.trees, [s.projectId]: files } }));
        },

        importRepo(url) {
          const clean = url.trim();
          if (!/^(https:\/\/)?(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+/.test(clean)) {
            get().toast("Paste a public repo URL, like https://github.com/owner/repo", "error");
            return;
          }
          const href = clean.startsWith("http") ? clean : `https://${clean}`;
          get().send(
            `Import an existing codebase. Run: git clone --depth 1 ${href} /tmp/import && cp -a /tmp/import/. . && rm -rf /tmp/import\n` +
              "Then list_dir the project, read the main entry files and the dependency manifest, install dependencies, and if it's a web app start it with start_process named \"web\" on 0.0.0.0:3000. " +
              "Do not change any source code. Checkpoint, then summarize the architecture: pages, endpoints, data models, services and external integrations.",
            { intent: "build" },
          );
        },

        setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
        setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
        toast(text, tone = "info") {
          const id = uid();
          set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
          setTimeout(() => get().dismissToast(id), tone === "error" ? 7000 : 3500);
        },
        dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

        /** After a reload: reattach to live runs (SSE replays from the start), close dead demo runs. */
        resumeStreams() {
          const s = get();
          for (const [projectId, runs] of Object.entries(s.runs)) {
            for (const r of runs) {
              // Runs cut off by a connection blip (error with no message) are reattached too.
              const blipped = r.status === "error" && (!r.error || /^(Lost the event stream|The server lost this run)/.test(r.error));
              if (r.status !== "running" && r.status !== "queued" && !blipped) continue;
              if (streams.has(r.id)) continue;
              if (s.mode === "live" && !r.id.includes("-") && r.id.length === 32) {
                patchRun(projectId, r.id, (x) => ({ ...x, events: [], status: "running", error: undefined, endedAt: undefined })); // replay rebuilds them
                subscribe(projectId, r.id);
              } else {
                patchRun(projectId, r.id, (x) => ({ ...x, status: "error", error: "Interrupted by a page reload", endedAt: Date.now() }));
              }
            }
          }
        },
      };
    },
    {
      name: "orqen",
      version: 1,
      partialize: (s) => ({ conn: s.conn, mode: s.mode, projects: s.projects, projectId: s.projectId, runs: s.runs, contents: s.contents, trees: s.trees, chatOpen: s.chatOpen }),
    },
  ),
);
