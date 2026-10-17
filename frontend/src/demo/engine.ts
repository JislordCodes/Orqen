import type { PlanFeature, RunMode, ServerEvent } from "@/lib/types";
import { AUTH_FILE, AUTH_TEST, BASE_FILES, BILLING_FILE } from "./files";

/**
 * Demo mode: a scripted agent that emits the exact event shapes the real worker
 * publishes (status, text, tool_start, tool_result, done). Lets the whole UI be
 * explored and pitched without Redis, Docker or a model key.
 */

type Step = { wait: number; ev?: ServerEvent; write?: [string, string] };

class Script {
  steps: Step[] = [];
  status() { this.steps.push({ wait: 200, ev: { type: "status", data: { state: "started" } } }); return this; }
  say(text: string, wait = 450) {
    // Stream in ~60-char chunks, like RunContext.emit_text batching.
    const parts = text.match(/[\s\S]{1,60}(\s|$)/g) ?? [text];
    parts.forEach((p, i) => this.steps.push({ wait: i ? 70 : wait, ev: { type: "text", data: { text: p } } }));
    return this;
  }
  tool(name: string, input: Record<string, unknown>, output: string, took = 500, write?: [string, string]) {
    this.steps.push({ wait: 260, ev: { type: "tool_start", data: { name, input } } });
    this.steps.push({ wait: took, ev: { type: "tool_result", data: { name, output } }, write });
    return this;
  }
  file(path: string, content: string) {
    return this.tool("create_file", { path, chars: content.length }, `wrote ${path} (${content.length} chars)`, 380, [path, content]);
  }
  edit(path: string, content: string) {
    return this.tool("str_replace", { path }, `edited ${path}`, 420, [path, content]);
  }
  view(path: string, content: string) {
    const lines = content.split("\n");
    const out = `[${path}: lines 1-${lines.length} of ${lines.length}]\n` + lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
    return this.tool("view_file", { path }, out.slice(0, 1500), 240);
  }
  cmd(cmd: string, exit: number, output: string, took = 900) {
    return this.tool("run_command", { cmd }, `exit=${exit}\n${output}`, took);
  }
  done(summary: string, state?: "awaiting_approval" | "built") { this.steps.push({ wait: 400, ev: { type: "done", data: { summary, state } } }); return this; }
  emit(ev: ServerEvent, wait = 200) { this.steps.push({ wait, ev }); return this; }
  features(marks: number) {
    const features = DEMO_FEATURES.map((f, i) => ({ ...f, passes: i < marks }));
    return this.emit({ type: "features", data: { total: features.length, passing: marks, features } });
  }
}

export interface DemoContext {
  prompt: string; // the raw user request (not the scoped wrapper)
  scopeNodeId?: string;
  scopeFiles: string[];
  files: Record<string, string>;
  mode?: RunMode;
}

const DEMO_FEATURES: PlanFeature[] = [
  { id: "F1", title: "Project skeleton + quality gates (checks.sh: tests)", plain: "A clean project that checks itself on every change", category: "setup", passes: false },
  { id: "F2", title: "Task model + SQLite persistence", plain: "Your tasks are saved and survive a restart", category: "data", passes: false },
  { id: "F3", title: "REST API: create, list, toggle, delete", plain: "Add, finish and remove tasks", category: "functional", passes: false },
  { id: "F4", title: "React UI wired to /api/tasks", plain: "A simple screen to manage your tasks", category: "ui", passes: false },
  { id: "F5", title: "Input validation + friendly errors", plain: "Clear messages when something is wrong", category: "quality", passes: false },
];

function planScript(s: Script, revising: boolean) {
  s.emit({ type: "phase", data: { phase: "planning" } })
    .say(revising ? "Updating the plan with your changes.\n" : "Planning before building, so you can check it first.\n", 400)
    .tool("list_dir", { path: "." }, "/workspace", 300)
    .tool("create_file", { path: ".orqen/spec.md", chars: 1840 }, "wrote .orqen/spec.md (1840 chars)", 500)
    .tool("create_file", { path: ".orqen/architecture.json", chars: 960 }, "wrote .orqen/architecture.json (960 chars)", 400)
    .tool("create_file", { path: ".orqen/features.json", chars: 1220 }, "wrote .orqen/features.json (1220 chars)", 400)
    .tool("submit_plan", { summary: "A task tracker" }, "Plan submitted with 5 features. Finish now with the summary.", 300)
    .emit({
      type: "plan",
      data: {
        summary: "A task tracker where you add, finish and remove tasks. Your tasks are saved, and the app explains any mistake in plain words.",
        questions: [],
        architecture: {
          stack: { frontend: "React + Vite", backend: "Flask", database: "SQLite" },
          components: [
            { id: "web", name: "Web app", kind: "frontend", tech: "React + Vite", plain: "The screen you use" },
            { id: "api", name: "Tasks API", kind: "service", tech: "Flask", plain: "Handles every change to your tasks" },
            { id: "db", name: "Database", kind: "database", tech: "SQLite", plain: "Where tasks are kept" },
          ],
          connections: [{ from: "web", to: "api", label: "REST /api/tasks" }, { from: "api", to: "db", label: "SQLAlchemy" }],
        },
        total: DEMO_FEATURES.length,
        passing: 0,
        features: DEMO_FEATURES,
      },
    })
    .say("Here's the plan: 5 features, from a self-checking skeleton to friendly errors. Approve it and I'll build and verify them one by one, or tell me what to change.")
    .done("Plan ready for approval.", "awaiting_approval");
  return s;
}

export function script(ctx: DemoContext): Script {
  const p = ctx.prompt.toLowerCase();
  const s = new Script().status();
  const empty = Object.keys(ctx.files).length === 0;

  if (/git clone/.test(p)) {
    const paths = Object.keys(BASE_FILES);
    s.say("Importing the repository without changing any code.\n", 400)
      .cmd(ctx.prompt.match(/git clone[^\n]+/)?.[0] ?? "git clone", 0, "Cloning into '/tmp/import'...\nReceiving objects: 100% (42/42), done.", 1600)
      .tool("list_dir", { path: "." }, ["/workspace", ...paths.map((f) => `/workspace/${f}`)].join("\n"), 400);
    // The import "lands" every file at once.
    paths.forEach((f) => s.steps.push({ wait: 40, write: [f, BASE_FILES[f]] }));
    s.view("server/app.py", BASE_FILES["server/app.py"])
      .view("web/src/App.jsx", BASE_FILES["web/src/App.jsx"])
      .cmd("pip install -r requirements.txt && npm install", 0, "Successfully installed flask-3.0.3 flask-sqlalchemy-3.1.1 pytest-8.3.3\nadded 64 packages in 5s", 1500)
      .tool("start_process", { name: "web", cmd: "python server/app.py" }, "started 'web'. First log lines:\n * Running on http://0.0.0.0:3000", 800)
      .tool("checkpoint", { message: "Import repository" }, "0a1b2c3 Import repository", 400)
      .say("Imported. It's a Flask API (`server/app.py`) with a service layer and a SQLAlchemy model, plus a React UI in `web/` that calls `/api/tasks`. One pytest file. No auth: every write endpoint is public.")
      .done("Repository imported and running on :3000.");
    return s;
  }

  if (empty && ctx.mode !== "build") return planScript(s, ctx.mode === "plan");

  if (empty) {
    s.emit({ type: "phase", data: { phase: "building", session: 1, max_sessions: 6 } });
    s.say("Building the approved plan, one feature at a time. Each one is verified before I move on.\n\n", 600)
      .tool("list_dir", { path: "." }, "/workspace", 300);
    for (const path of ["README.md", ".gitignore", "requirements.txt", "package.json", "server/models.py", "server/services/tasks.py", "server/app.py", "web/index.html", "web/src/App.jsx", "web/src/components/TaskList.jsx"]) {
      s.file(path, BASE_FILES[path]);
    }
    s.cmd("pip install -r requirements.txt && pip install flask flask-sqlalchemy pytest", 0, "Successfully installed flask-3.0.3 flask-sqlalchemy-3.1.1 pytest-8.3.3", 1500)
      .cmd("npm install react react-dom vite @vitejs/plugin-react && npm run build", 0, "added 64 packages in 6s\nvite v5.4.10 building for production...\n✓ built in 812ms", 1700)
      .features(2)
      .file("tests/test_api.py", BASE_FILES["tests/test_api.py"])
      .cmd("pytest -q", 0, ".                                                    [100%]\n1 passed in 0.41s", 1100)
      .tool("run_checks", {}, "PASS (exit=0)\n1 passed in 0.41s", 700)
      .tool("mark_feature", { id: "F3", passes: true }, "F3 marked passing. 3/5 pass. Next: F4.", 200)
      .features(3)
      .tool("start_process", { name: "web", cmd: "python server/app.py" }, "started 'web'. First log lines:\n * Running on http://0.0.0.0:3000", 900)
      .tool("read_process_logs", { name: "web" }, "STATUS: running\n * Serving Flask app 'app'\n * Running on http://0.0.0.0:3000", 400)
      .cmd("curl -s -X POST localhost:3000/api/tasks -H 'Content-Type: application/json' -d '{\"title\":\"hello\"}'", 0, '{"done":false,"id":1,"title":"hello"}', 500)
      .tool("mark_feature", { id: "F4", passes: true }, "F4 marked passing. 4/5 pass. Next: F5.", 200)
      .features(4)
      .tool("mark_feature", { id: "F5", passes: true }, "F5 marked passing. 5/5 pass. All features pass.", 200)
      .features(5)
      .tool("checkpoint", { message: "Task tracker: API, UI, tests" }, "a1f3c9e Task tracker: API, UI, tests", 500)
      .tool("update_progress", { chars: 180 }, "saved", 200)
      .say("Built a task tracker: Flask API in `server/`, React UI in `web/`, SQLite storage, and one end-to-end test that passes. It's running as `web` on port 3000, so the preview is live. Not done yet: there's no sign-in, so every endpoint is public.")
      .done("Task tracker built and running on :3000. Tests pass. No auth yet.");
    return s;
  }

  if (/auth|login|sign.?in|account|guard/.test(p)) {
    const models = (ctx.files["server/models.py"] ?? BASE_FILES["server/models.py"]) + `

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
`;
    const app = (ctx.files["server/app.py"] ?? BASE_FILES["server/app.py"])
      .replace("from server.services import tasks", "from server.services import tasks\nfrom server.auth import login_required, login, register")
      .replace('db.init_app(app)', 'app.secret_key = os.environ["SECRET_KEY"]\ndb.init_app(app)')
      .replace(/@app\.(post|patch|delete)\(/g, (m) => `${m}`)
      .replace(/(@app\.(?:post|patch|delete)\([^)]*\)\n)/g, "$1@login_required\n");
    s.say("Adding session-based auth. Reads stay public, writes need a signed-in user. Callers in the interface will need to handle 401s.\n", 500)
      .view("server/app.py", ctx.files["server/app.py"] ?? BASE_FILES["server/app.py"])
      .edit("server/models.py", models)
      .file("server/auth.py", AUTH_FILE)
      .edit("server/app.py", app)
      .file("tests/test_auth.py", AUTH_TEST)
      .cmd("pytest -q", 1, "F..\nFAILED tests/test_api.py::test_create_toggle_delete - assert 401 == 201\n1 failed, 2 passed in 0.52s", 1100)
      .say("The old test creates tasks anonymously, which is now correctly rejected. Updating the test fixture to sign in first.\n")
      .edit("tests/test_api.py", (ctx.files["tests/test_api.py"] ?? BASE_FILES["tests/test_api.py"]).replace("yield app.test_client()", "c = app.test_client()\n        c.post(\"/api/register\", json={\"email\": \"t@t.co\", \"password\": \"pw-12345\"})\n        c.post(\"/api/login\", json={\"email\": \"t@t.co\", \"password\": \"pw-12345\"})\n        yield c"))
      .cmd("pytest -q", 0, "...                                                  [100%]\n3 passed in 0.49s", 1000)
      .file(".env.example", "SECRET_KEY=change-me\nDATABASE_URL=sqlite:///tasks.sqlite3\n")
      .tool("stop_process", { name: "web" }, "stopped", 200)
      .tool("start_process", { name: "web", cmd: "python server/app.py" }, "started 'web'. First log lines:\n * Running on http://0.0.0.0:3000", 700)
      .tool("checkpoint", { message: "Session auth on all write endpoints" }, "b72d4e1 Session auth on all write endpoints", 400)
      .say("Done. `server/auth.py` adds register, login and a `login_required` guard on every POST, PATCH and DELETE. Tests cover both rejected and allowed writes (3 passing). Set `SECRET_KEY` from `.env.example`.")
      .done("Auth added; 3 tests pass.");
    return s;
  }

  if (/stripe|pay|billing|checkout|subscri/.test(p)) {
    s.say("Adding Stripe Checkout for a subscription. The key comes from the environment, never the code.\n", 500)
      .cmd("pip install stripe", 0, "Successfully installed stripe-10.12.0", 1200)
      .file("server/services/billing.py", BILLING_FILE)
      .edit("server/app.py", (ctx.files["server/app.py"] ?? BASE_FILES["server/app.py"]).replace('\n\n@app.get("/")', '\n\n@app.post("/api/checkout")\ndef checkout():\n    from server.services.billing import checkout_url\n    return jsonify(url=checkout_url(user_id=0, price_id=request.json["price_id"]))\n\n\n@app.get("/")'))
      .cmd("python -c 'import server.services.billing'", 1, "KeyError: 'STRIPE_SECRET_KEY'", 600)
      .say("Import fails without the key, as expected. Skipping a live call; the route is wired. You'll need to add STRIPE_SECRET_KEY.\n")
      .tool("checkpoint", { message: "Stripe checkout route" }, "c03ab88 Stripe checkout route", 400)
      .done("Stripe checkout route added. Needs STRIPE_SECRET_KEY and a .env.example entry.");
    return s;
  }

  if (/audit|review|secur|vulnerab/.test(p)) {
    s.say("Auditing the project for security and structure.\n", 400).tool("list_dir", { path: "." }, Object.keys(ctx.files).map((f) => `/workspace/${f}`).join("\n"), 300);
    for (const f of Object.keys(ctx.files).filter((f) => /\.(py|jsx?|tsx?)$/.test(f)).slice(0, 5)) s.view(f, ctx.files[f]);
    s.tool("grep", { pattern: "debug=True|SECRET|api_key", path: "." }, "no matches", 300)
      .cmd("pytest -q", 0, "1 passed in 0.40s", 900);
    const hasAuth = Object.keys(ctx.files).some((f) => f.includes("auth"));
    s.say(hasAuth
      ? "Findings:\n1. Auth guards cover every write endpoint. Good.\n2. No rate limiting on /api/login. Brute force is possible.\n3. Errors from the service layer bubble up as 500s with no JSON body.\nNo code changed. Ask me to fix any of these."
      : "Findings:\n1. Critical: every write endpoint (POST, PATCH, DELETE /api/tasks) is public.\n2. No input length limit on task titles beyond the DB column.\n3. Service errors return HTML 500s instead of JSON.\nNo code changed. Ask me to fix any of these.")
      .done("Audit complete. No code changed.");
    return s;
  }

  if (/rename|contract|payload|schema|field/.test(p)) {
    const models = (ctx.files["server/models.py"] ?? BASE_FILES["server/models.py"]).replace(/title/g, "name");
    s.say("Renaming the task field `title` to `name` in the data model. That's a contract change, so callers must follow.\n", 500)
      .edit("server/models.py", models)
      .cmd("pytest -q", 1, "F\nFAILED tests/test_api.py::test_create_toggle_delete\nserver/services/tasks.py:9: TypeError: 'title' is an invalid keyword argument for Task\n1 failed in 0.47s", 1200)
      .say("As expected, `server/services/tasks.py` and the interface still send `title`. Updating every caller.\n", 900)
      .edit("server/services/tasks.py", (ctx.files["server/services/tasks.py"] ?? BASE_FILES["server/services/tasks.py"]).replace(/title/g, "name"))
      .edit("server/app.py", (ctx.files["server/app.py"] ?? BASE_FILES["server/app.py"]).replace('title=body["title"]', 'name=body["name"]'))
      .edit("web/src/App.jsx", (ctx.files["web/src/App.jsx"] ?? BASE_FILES["web/src/App.jsx"]).replace("JSON.stringify({ title })", "JSON.stringify({ name: title })"))
      .edit("web/src/components/TaskList.jsx", (ctx.files["web/src/components/TaskList.jsx"] ?? BASE_FILES["web/src/components/TaskList.jsx"]).replace("{t.title}", "{t.name}"))
      .edit("tests/test_api.py", (ctx.files["tests/test_api.py"] ?? BASE_FILES["tests/test_api.py"]).replace('{"title": "Ship it"}', '{"name": "Ship it"}'))
      .cmd("pytest -q", 0, ".                                                    [100%]\n1 passed in 0.42s", 1000)
      .tool("checkpoint", { message: "Rename task.title -> task.name across all callers" }, "d91e0a2 Rename task.title -> task.name", 400)
      .done("Renamed title → name in Data, Logic, API, Interface and Tests. Tests pass.");
    return s;
  }

  if (/test/.test(p)) {
    const t = `def test_empty_title_rejected(client):\n    r = client.post("/api/tasks", json={"title": "  "})\n    assert r.status_code == 400\n`;
    s.say("Writing tests for the edge cases.\n", 400)
      .file("tests/test_validation.py", t)
      .cmd("pytest -q", 1, ".F\nFAILED tests/test_validation.py::test_empty_title_rejected - assert 500 == 400\n1 failed, 1 passed", 1000)
      .say("Found a real bug: an empty title raises ValueError and returns a 500. Returning a 400 instead.\n")
      .edit("server/app.py", (ctx.files["server/app.py"] ?? BASE_FILES["server/app.py"]).replace('    task = tasks.create(title=body["title"])', '    try:\n        task = tasks.create(title=body["title"])\n    except ValueError as e:\n        return jsonify(error=str(e)), 400'))
      .cmd("pytest -q", 0, "..                                                   [100%]\n2 passed in 0.44s", 900)
      .tool("checkpoint", { message: "Validate empty titles" }, "e11b7c0 Validate empty titles", 400)
      .done("Added a validation test, which caught a bug, and fixed it. 2 passing.");
    return s;
  }

  // Generic scoped edit
  const target = ctx.scopeFiles.find((f) => ctx.files[f] && !/\.(md|json|txt)$/.test(f)) ?? Object.keys(ctx.files).find((f) => f.endsWith(".py")) ?? "README.md";
  const before = ctx.files[target] ?? "";
  const marker = target.endsWith(".py") ? "#" : target.endsWith(".md") ? "<!--" : "//";
  const note = marker === "<!--" ? `<!-- ${ctx.prompt} -->` : `${marker} ${ctx.prompt}`;
  s.say(`Working on ${target}.\n`, 400)
    .view(target, before)
    .edit(target, `${note}\n${before}`)
    .cmd("pytest -q", 0, "1 passed in 0.40s", 900)
    .tool("checkpoint", { message: ctx.prompt.slice(0, 60) }, `f00d123 ${ctx.prompt.slice(0, 60)}`, 400)
    .say(`Updated ${target}. Tests still pass.`)
    .done(`Updated ${target}.`);
  return s;
}

export function runDemo(ctx: DemoContext, onEvent: (e: ServerEvent, id: string) => void, onWrite: (path: string, content: string) => void) {
  const { steps } = script(ctx);
  let i = 0;
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const tick = () => {
    if (stopped || i >= steps.length) return;
    const step = steps[i++];
    timer = setTimeout(() => {
      if (stopped) return;
      if (step.write) onWrite(step.write[0], step.write[1]);
      if (step.ev) onEvent(step.ev, `${Date.now()}-${i}`);
      tick();
    }, step.wait);
  };
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
