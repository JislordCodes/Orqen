# Orqen · frontend

The node-canvas editor for Orqen. You describe a system in the chat bar, the agent writes real code in your sandbox, and every page, endpoint, table and service it creates shows up as a node, wired to what it depends on. Click a node to read its code, see what would break if it changed, and send a prompt scoped to just that part.

**Stack:** Vite · React 18 · TypeScript · Tailwind v4 · React Flow (`@xyflow/react`) · Monaco · Zustand · dagre. The UI primitives are shaped like shadcn/ui, styled to the brief in the root README: warm off-white paper, Doto dot-matrix display type, Geist for the UI, hairline wires.

## Run

```bash
cd frontend
cp .env.example .env      # VITE_API_URL=http://localhost:8000, VITE_USER_ID=demo-user
npm install
npm run dev               # http://localhost:5173 (the port the backend's CORS allows)
```

There's no backend yet? Leave `VITE_API_URL` empty, or switch to **Demo** from the status pill in the top bar. A scripted agent sends the same events the worker publishes, so every screen works with no Redis, Docker or model key.

## Pitch script (about 3 minutes, Demo mode)

1. **Build.** Click the *Task tracker* template. The canvas fills in live, node by node, as the agent writes files. The node it's writing gets a moving dotted outline and its wires march.
2. **Guardrail.** When it finishes, the API node turns amber: *API has no auth boundary*. The Tests tab lists it with a one-click **Fix with agent**.
3. **Scoped change + blast radius.** Click the **Data** node, then tap the *Rename a field* chip. Before you send, the canvas shows in red dashes everything that depends on Data. Send *"rename title to name"*. Tests fail mid-run and the affected nodes go red. Then the agent updates every caller and they turn green again.
4. **Inspector.** Open **Code** on any node to see the file in Monaco. **Activity** shows every step the agent took on that component.
5. **Executions.** Every prompt is replayable as a timeline with the files it changed. Hit *Run again*.
6. **Preview.** The live app runs in the side drawer at desktop or phone width.

Prompts the demo agent understands: *auth / login*, *stripe / payment*, *rename … field*, *tests*, *audit*, a GitHub URL (*Map repo*), and anything else as a generic scoped edit.

## How it maps to the backend

The frontend uses only the routes in `backend/app/api.py`:

| UI | Route |
|---|---|
| Chat bar, node prompts, Fix, Audit, Write tests, Map repo | `POST /runs { prompt, project_id }` |
| Live canvas, chat transcript, Executions timeline | `GET /runs/{id}/events` (SSE, via `EventSource` + `?user_id=`; replays on reconnect) |
| Preview drawer | `POST /preview { project_id }` |
| Status pill | `GET /health` |

- **Projects** map 1:1 to `project_id` (the same slug rules as `check_project`), so each one gets its own sandbox and agent memory.
- **One run per project.** The UI blocks a second send and handles the server's 409.
- **401 / 501 / network errors** come back as plain-language toasts. A 501 from `/preview` explains how to set `PREVIEW_DOMAIN`.

### Where the canvas comes from

The API has no graph endpoint, and it shouldn't need one. The canvas is **derived from the event stream** (`src/lib/workspace.ts` → `src/lib/architecture.ts`):

1. Every `tool_start` / `tool_result` pair is replayed into a workspace model: files written or edited (`create_file`, `str_replace`), files seen (`list_dir`, `view_file`), processes (`start_process`, `read_process_logs`), commands with exit codes (`run_command`), packages installed, and checkpoints.
2. Files are classified into components: **Interface, API, Auth, Logic, Data, Tests, Setup**. Long-running processes become **Runtime** nodes, and known SDK installs (Stripe, OpenAI, Resend, Supabase and so on) become **Integration** nodes.
3. Wires follow the call direction: Runtime → Interface → API → Logic → Data, with API → Auth, Logic → Integrations, and Tests ⇢ what they verify.
4. **Guardrails** are deterministic rules on that model. Each one carries the exact prompt that fixes it: no auth in front of the API, failing tests, nothing tested, secrets without `.env.example`, `debug=True`, hard-coded keys, localhost URLs in the UI, preview not running, no `.gitignore` or README.
5. **Blast radius** is everything that transitively depends on a node. A scoped prompt names those parts and tells the agent to keep them working and update callers if a contract changes (`scopedPrompt()` in `architecture.ts`).

Because the source of truth is the real stream of file and command events, the canvas can't drift from the code.

## Optional backend endpoints (recommended)

The code view shows a file's text once the agent has `view_file`d it. To show any file instantly, and to map sandboxes that were built outside this browser, add these two read-only routes to `backend/app/api.py`. The frontend detects them automatically.

```python
import asyncio
from . import sandbox

@app.get("/projects/{project_id}/files")
async def list_files(project_id: str, uid: str = Depends(current_user)):
    sid = f"{uid}-{check_project(project_id)}"
    cmd = "find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | sed 's|^./||' | sort | head -n 2000"
    _, out = await asyncio.to_thread(sandbox.sh, sid, cmd, 20)
    return {"files": [l for l in out.splitlines() if l]}

@app.get("/projects/{project_id}/file")
async def get_file(project_id: str, path: str, uid: str = Depends(current_user)):
    sid = f"{uid}-{check_project(project_id)}"
    try:
        return {"content": await asyncio.to_thread(sandbox.read_file, sid, path)}
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(404, str(e))
```

(If you add them, also add them to the API table in the root README, per the repo rule.)

## Map

```
src/
  lib/
    api.ts            backend client (runs, SSE, preview, health, optional files)
    types.ts          wire types (mirror events.py) + derived model types
    workspace.ts      event stream → files / processes / commands / steps / timeline
    architecture.ts   workspace → components, wires, guardrails, blast radius, scoped prompts
    layout.ts         dagre left-to-right layout
    useModel.ts       memoised model shared by every view
  store/useStore.ts   projects, runs, streaming, preview, UI state (persisted to localStorage)
  demo/               scripted agent + sample files (Demo mode)
  components/
    canvas/           Canvas, ComponentNode, WireEdge, EmptyCanvas, CanvasHud
    inspector/        Inspector (overview / code / activity), CodeView (Monaco)
    chat/             ChatDock, StepRow, Markdownish
    executions/       ExecutionsView
    tests/            TestsView (guardrails + test runs)
    layout/           TopBar, PreviewDrawer, Dialogs (settings, new project, toasts)
    ui/               Button and small primitives
```

## Known limits

- Runs and projects are stored in `localStorage`. There's no server-side project list yet.
- File contents depend on `view_file` captures or the optional endpoints above.
- Code is read-only on purpose. Changes go through the agent, so the graph and the checkpoints stay true.
- There's no cancel button, because the API has no cancel route yet.
- Monaco loads from a CDN on first open. Bundle it locally if demo-day Wi-Fi is weak.
