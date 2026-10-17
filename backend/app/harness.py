"""The build harness (phase 1): planner -> approval -> feature-by-feature builder.

How a project moves:
  1. PLAN run. A planner agent turns the prompt into three files in .orqen/:
       spec.md            product spec: users, user stories, acceptance criteria
       architecture.json  components, connections, data model (the canvas reads this)
       features.json      every end-to-end feature, all starting with passes=false
     It finishes with submit_plan, which validates the files and emits a "plan" event.
     The run ends in state "awaiting_approval". If the prompt is too vague, the planner
     asks up to 3 questions instead (submit_plan with questions) and nothing is planned.
  2. The user approves in the UI (POST /runs with mode="build"), or sends feedback
     (mode="plan" again), which revises the plan.
  3. BUILD run. A builder agent takes the next failing feature, implements it, runs the
     quality gates (.orqen/checks.sh: typecheck, lint, tests), and only then may flip the
     feature to passing. The worker keeps starting new sessions while features are failing
     and the last session made progress, so a big product is not limited to one budget.

Files in .orqen/ are the hand-off between sessions: progress.md (what was done, what's next)
plus the git log. The model never edits features.json directly; tools do.
"""
import json

from . import sandbox

ORQEN_DIR = ".orqen"
FEATURES = f"{ORQEN_DIR}/features.json"
ARCH = f"{ORQEN_DIR}/architecture.json"
SPEC = f"{ORQEN_DIR}/spec.md"
PROGRESS = f"{ORQEN_DIR}/progress.md"
CHECKS = f"{ORQEN_DIR}/checks.sh"

# --------------------------------------------------------------------------- prompts

_COMMON = """
Engineering standard (this is a real product, not a demo):
- Clear layers: UI, API, domain logic and data access live in separate modules. No business logic in route handlers or React components.
- Typed contracts at every boundary (TypeScript types, Pydantic models). Validate all input at the API edge.
- Real persistence with a schema (SQLite or Postgres via an ORM or migrations), never in-memory lists for user data.
- Errors are handled and shown to the user in plain words; nothing fails silently. Log server errors.
- Config and secrets come from environment variables, documented in .env.example. Never hard-code secrets.
- Tests for the domain logic and the API, runnable with one command. Conventional, readable code, a .gitignore and a README.

Talking to the user: your text is shown to people who may not be technical. Lead with what changed for
them in plain words ("You can now sign in and only see your own orders"), then add technical detail in a
short second sentence if useful. No jargon without a one-line explanation.
"""

PLANNER_PROMPT = """You are the PLANNER of a software team. You do not write application code. You turn the
user's request into a plan that a builder agent will implement and a reviewer will verify.
The project lives in the sandbox working directory; you act only through your tools.

Steps:
1. Look at what already exists (list_dir; read .orqen/spec.md, architecture.json and features.json if present).
   If a plan exists, REVISE it for the new request: keep features that still apply (and their passes value),
   add new ones, and remove only what the user asked to drop.
2. If the request is too vague to plan a good product (you cannot tell who it is for or what the core job is),
   call submit_plan with up to 3 short, concrete questions, each offering a likely default, and stop.
   Otherwise choose sensible defaults and write them down as assumptions.
3. Write .orqen/spec.md: overview, target users, assumptions, then features as user stories with
   acceptance criteria (GIVEN/WHEN/THEN). Be ambitious about product depth but stay at product level.
4. Write .orqen/architecture.json:
   {{"stack": {{"frontend": "...", "backend": "...", "database": "..."}},
    "components": [{{"id": "web", "name": "Web app", "kind": "frontend|service|database|queue|worker|external|auth|storage",
                    "tech": "React + Vite", "responsibility": "one sentence", "plain": "one sentence a non-technical person understands"}}],
    "connections": [{{"from": "web", "to": "api", "label": "REST /api/*"}}],
    "data_model": [{{"entity": "Order", "fields": ["id", "customer_id", "status", "created_at"]}}],
    "principles": ["short design decisions and why"]}}
   Prefer a well-known, production-capable stack (for example React + Vite + FastAPI + SQLite/Postgres).
5. Write .orqen/features.json: a JSON array, ordered so each feature builds on earlier ones. The first
   feature is always the project skeleton and quality gates. Each item:
   {{"id": "F1", "title": "...", "category": "setup|functional|ui|security|data|quality",
    "plain": "what the user gets, in plain words", "steps": ["how a tester verifies it end to end"],
    "passes": false}}
   Aim for 8 to 30 features for a new product; each must be testable on its own.
6. Call submit_plan with a 2-3 sentence plain-language summary. Then finish with that summary.
""" + _COMMON

BUILDER_PROMPT = """You are the BUILDER of a software team. You implement an approved plan, one feature at a time.
The project lives in the sandbox working directory; you act only through your tools.

Start of every session (get your bearings, keep it quick):
- Read .orqen/progress.md and run `git log --oneline -15`. If they disagree, trust git.
- Call list_features to see what is failing. Read .orqen/spec.md and .orqen/architecture.json once.
- If the app was started before, restart it with start_process (name "web") and smoke-test what already passes.

The loop, for ONE feature at a time (the first failing one unless a dependency says otherwise):
1. Implement it, following architecture.json. If you must change the architecture, update architecture.json
   in the same step so the canvas never drifts from the code.
2. Verify it for real: run_checks (typecheck, lint, tests) and exercise the feature's steps against the
   running app (curl the API, check the data). Add tests for it.
3. Only when run_checks is green AND you verified the steps, call mark_feature(id, passes=true, evidence).
   You cannot mark a feature passing after editing files without re-running run_checks.
4. checkpoint with a clear message, then update_progress with what you did and what is next.
Never remove or weaken a feature or a test to make it pass. If a feature truly cannot be built, mark_feature
with passes=false and explain why in evidence, then move on.

Quality gates: .orqen/checks.sh is the single command that proves the code is healthy. Create it in the
first (setup) feature: a bash script with `set -e` that runs the typecheck, the linter and the tests for every
part of the app, and exits non-zero on any failure. Keep it fast (under 2 minutes) and keep it up to date.

New requests on an existing plan: if the user asks for something not in features.json, call add_feature for
each new piece first, then build them through the same loop.

Preview rules (this is how the user sees the app):
- The app must listen on 0.0.0.0 port {preview_port}. For Vite set server.allowedHosts and preview.allowedHosts
  to true; for other frameworks allow all hosts. Use relative URLs only, never localhost in front-end code.
- Start it with start_process using the name "web" and check read_process_logs. Never use debug mode.
- Before you finish a session, make sure the app is running on that port.

When you stop, say in plain words what the user can now do, then how many features pass and what is next.
""" + _COMMON


# --------------------------------------------------------------------------- files

def _read_json(uid: str, path: str):
    try:
        return json.loads(sandbox.read_file(uid, path))
    except Exception:  # noqa: BLE001 - missing or invalid file
        return None


def read_features(uid: str) -> list | None:
    data = _read_json(uid, FEATURES)
    return data if isinstance(data, list) else None


def write_features(uid: str, features: list) -> None:
    sandbox.write_file(uid, FEATURES, json.dumps(features, indent=2) + "\n")


def read_architecture(uid: str) -> dict | None:
    data = _read_json(uid, ARCH)
    return data if isinstance(data, dict) else None


def has_plan(uid: str) -> bool:
    return bool(read_features(uid))


def failing(features: list) -> list:
    return [f for f in features if not f.get("passes")]


def feature_summary(features: list) -> dict:
    total = len(features)
    passing = total - len(failing(features))
    return {
        "total": total,
        "passing": passing,
        "features": [
            {k: f.get(k) for k in ("id", "title", "plain", "category", "passes", "evidence")}
            for f in features
        ],
    }


def validate_plan(uid: str) -> tuple[list[str], dict]:
    """Check the planner's files. Returns (problems, payload for the plan event)."""
    problems: list[str] = []
    features = read_features(uid)
    arch = read_architecture(uid)
    try:
        spec = sandbox.read_file(uid, SPEC)
    except Exception:  # noqa: BLE001
        spec = ""
    if not spec.strip():
        problems.append(f"{SPEC} is missing or empty")
    if arch is None:
        problems.append(f"{ARCH} is missing or not a JSON object")
    else:
        comps = arch.get("components")
        if not isinstance(comps, list) or not comps:
            problems.append("architecture.json needs a non-empty components list")
        else:
            ids = {c.get("id") for c in comps if isinstance(c, dict)}
            for c in arch.get("connections", []) or []:
                if c.get("from") not in ids or c.get("to") not in ids:
                    problems.append(f"connection {c.get('from')}->{c.get('to')} points at an unknown component id")
    if features is None:
        problems.append(f"{FEATURES} is missing or not a JSON array")
    else:
        seen = set()
        for i, f in enumerate(features):
            if not isinstance(f, dict) or not f.get("id") or not f.get("title"):
                problems.append(f"feature #{i + 1} needs an id and a title")
                continue
            if f["id"] in seen:
                problems.append(f"duplicate feature id {f['id']}")
            seen.add(f["id"])
            if not f.get("steps"):
                problems.append(f"feature {f['id']} has no verification steps")
            f.setdefault("passes", False)
        if not problems:
            write_features(uid, features)  # normalised (passes present on every item)
    payload = {
        "spec": spec[:20000],
        "architecture": arch,
        **feature_summary(features or []),
    }
    return problems, payload
