"""Agent tools. Every tool runs INSIDE the user's sandbox, never on the host.

build_tools(ctx) returns closures bound to one run (user + run id), so tools know
whose sandbox to use and where to publish events. Docstrings matter: Strands sends
them to the model as the tool descriptions.
"""
import json
import re
import shlex

from strands import tool

from . import config, harness, sandbox
from .events import RunContext

MAX_OUT = 6000  # characters returned to the model per tool call


def _clip(text: str, n: int = MAX_OUT) -> str:
    if len(text) <= n:
        return text
    half = n // 2
    return text[:half] + "\n...[output truncated]...\n" + text[-half:]


EDIT_TOOLS = {"create_file", "str_replace"}
BREAKER_LIMIT = 3  # identical failing calls before we refuse and force a new approach


def _failed(name: str, out: str) -> bool:
    if out.startswith(("ERROR", "BLOCKED", "STOP")):
        return True
    return name in ("run_command", "run_checks") and not out.startswith(("exit=0", "PASS"))


def build_tools(ctx: RunContext, role: str = "builder") -> list:
    """role: "planner" (reads the project, writes .orqen/ plan files) or "builder"."""
    uid = ctx.sandbox_id  # the sandbox is per project (user + project)
    fail_counts: dict[str, int] = {}

    def run(name: str, shown_input: dict, fn, key_input: dict | None = None) -> str:
        """Common wrapper: emit events, enforce the tool budget, turn errors into text
        so the model can read them and fix its own mistakes, and stop loops: the same
        failing call repeated BREAKER_LIMIT times is refused until the agent changes tack."""
        n = ctx.next_tool_call()
        ctx.flush_text()
        ctx.emit("tool_start", {"name": name, "input": shown_input})
        # Include the edit counter: retrying after changing code is fine, retrying blindly is not.
        key = f"{name}:{ctx.edits}:" + json.dumps(key_input if key_input is not None else shown_input, sort_keys=True, default=str)
        if n > config.MAX_TOOL_CALLS:
            out = "STOP: tool-call budget for this session is used up. Call update_progress with what is done and what is next, then finish."
        elif fail_counts.get(key, 0) >= BREAKER_LIMIT:
            out = (
                f"BLOCKED: this exact call already failed {BREAKER_LIMIT} times. Do not repeat it. "
                "Re-read the error, look at the relevant files, and try a different approach."
            )
        else:
            try:
                out = fn()
            except Exception as e:  # noqa: BLE001 - the model should see every failure
                out = f"ERROR: {e}"
            if _failed(name, out):
                fail_counts[key] = fail_counts.get(key, 0) + 1
            else:
                fail_counts.pop(key, None)
            if name in EDIT_TOOLS and not out.startswith("ERROR"):
                ctx.dirty = True  # code changed since the last green run_checks
                ctx.edits += 1
        out = _clip(out)
        ctx.emit("tool_result", {"name": name, "output": out[:1500]})
        return out

    def guard_plan_files(path: str) -> str | None:
        norm = sandbox.safe_path(path)
        if role == "builder" and norm == sandbox.safe_path(harness.FEATURES):
            return "ERROR: features.json is managed by the harness. Use add_feature or mark_feature."
        if role == "planner" and not norm.startswith(sandbox.safe_path(harness.ORQEN_DIR) + "/"):
            return "ERROR: the planner only writes files inside .orqen/. The builder writes the code."
        return None

    # ---------------------------------------------------------------- reading

    @tool
    def list_dir(path: str = ".") -> str:
        """List files and folders (up to 3 levels deep, ignoring node_modules and .git).

        Args:
            path: Directory relative to the project root. Defaults to the root.
        """

        def go():
            full = sandbox.safe_path(path)
            cmd = (
                f"find {shlex.quote(full)} -maxdepth 3 -not -path '*/node_modules*' "
                f"-not -path '*/.git/*' | sort | head -n 300"
            )
            _, out = sandbox.sh(uid, cmd, timeout=20)
            return out or "(empty)"

        return run("list_dir", {"path": path}, go)

    @tool
    def view_file(path: str, start_line: int = 1, end_line: int = 0) -> str:
        """Read a text file with line numbers. Use start_line/end_line for big files.

        Args:
            path: File path relative to the project root.
            start_line: First line to show (1-based).
            end_line: Last line to show. 0 means up to 400 lines from start_line.
        """

        def go():
            lines = sandbox.read_file(uid, path).splitlines()
            start = max(start_line, 1)
            end = end_line if end_line > 0 else start + 399
            chunk = lines[start - 1 : end]
            numbered = "\n".join(f"{i}\t{line}" for i, line in enumerate(chunk, start))
            return f"[{path}: lines {start}-{start + len(chunk) - 1} of {len(lines)}]\n{numbered}"

        return run("view_file", {"path": path}, go)

    @tool
    def grep(pattern: str, path: str = ".") -> str:
        """Search file contents recursively (regex). Ignores node_modules and .git.

        Args:
            pattern: Regular expression to search for.
            path: Directory or file to search, relative to the project root.
        """

        def go():
            full = sandbox.safe_path(path)
            cmd = (
                "grep -rnIE --exclude-dir=node_modules --exclude-dir=.git "
                f"-e {shlex.quote(pattern)} {shlex.quote(full)} | head -n 100"
            )
            _, out = sandbox.sh(uid, cmd, timeout=30)
            return out or "no matches"

        return run("grep", {"pattern": pattern, "path": path}, go)

    # ---------------------------------------------------------------- editing

    @tool
    def create_file(path: str, content: str) -> str:
        """Create a new file, or completely overwrite an existing one. Parent folders are
        created automatically. For small changes to existing files use str_replace instead.

        Args:
            path: File path relative to the project root.
            content: Full text content of the file.
        """

        def go():
            if (msg := guard_plan_files(path)):
                return msg
            sandbox.write_file(uid, path, content)
            return f"wrote {path} ({len(content)} chars)"

        return run("create_file", {"path": path, "chars": len(content)}, go, {"path": path, "h": hash(content)})

    @tool
    def str_replace(path: str, old_str: str, new_str: str) -> str:
        """Edit a file by replacing one exact piece of text with another. old_str must match
        the file exactly (including whitespace) and appear exactly once; include a few
        surrounding lines to make it unique.

        Args:
            path: File path relative to the project root.
            old_str: Exact existing text to replace.
            new_str: Replacement text (may be empty to delete).
        """

        def go():
            if (msg := guard_plan_files(path)):
                return msg
            text = sandbox.read_file(uid, path)
            count = text.count(old_str)
            if count == 0:
                return "ERROR: old_str not found. View the file again and copy the text exactly."
            if count > 1:
                return f"ERROR: old_str appears {count} times. Add more surrounding lines so it is unique."
            sandbox.write_file(uid, path, text.replace(old_str, new_str, 1))
            return f"edited {path}"

        return run("str_replace", {"path": path}, go, {"path": path, "old": old_str[:200]})

    # ---------------------------------------------------------------- running

    @tool
    def run_command(cmd: str, timeout_seconds: int = 60) -> str:
        """Run a shell command in the project root and return its output and exit code.
        Use for installs, builds, tests, linters, git. NOT for servers that keep running:
        use start_process for those.

        Args:
            cmd: The bash command to run.
            timeout_seconds: Kill the command after this many seconds (max 300).
        """

        def go():
            t = min(max(timeout_seconds, 1), 300)
            code, out = sandbox.sh(uid, cmd, timeout=t)
            note = " (TIMED OUT)" if code == 124 else ""
            return f"exit={code}{note}\n{out}"

        return run("run_command", {"cmd": cmd}, go)

    @tool
    def start_process(name: str, cmd: str) -> str:
        """Start a long-running process in the background (dev server, watcher, database).
        Output is saved to a log you can read with read_process_logs.

        Args:
            name: Short id for the process, lowercase letters/digits/dashes, e.g. "web".
            cmd: The command to run, e.g. "npm run dev".
        """

        def go():
            if not re.fullmatch(r"[a-z0-9_-]{1,30}", name):
                return "ERROR: name must be lowercase letters, digits, - or _ (max 30)."
            log, pid = f"/tmp/proc-{name}.log", f"/tmp/proc-{name}.pid"
            launch = (
                f"setsid nohup bash -lc {shlex.quote(cmd)} > {log} 2>&1 & echo $! > {pid}; "
                f"sleep 2; tail -n 20 {log}"
            )
            _, out = sandbox.sh(uid, launch, timeout=30)
            return f"started '{name}'. First log lines:\n{out}"

        return run("start_process", {"name": name, "cmd": cmd}, go)

    @tool
    def read_process_logs(name: str, lines: int = 80) -> str:
        """Show the latest log lines of a background process and whether it is still running.

        Args:
            name: The process name given to start_process.
            lines: How many recent lines to show.
        """

        def go():
            if not re.fullmatch(r"[a-z0-9_-]{1,30}", name):
                return "ERROR: invalid process name."
            log, pid = f"/tmp/proc-{name}.log", f"/tmp/proc-{name}.pid"
            cmd = (
                f"if [ -f {pid} ] && kill -0 $(cat {pid}) 2>/dev/null; then echo STATUS: running; "
                f"else echo STATUS: not running; fi; tail -n {int(lines)} {log} 2>&1"
            )
            _, out = sandbox.sh(uid, cmd, timeout=20)
            return out

        return run("read_process_logs", {"name": name}, go)

    @tool
    def stop_process(name: str) -> str:
        """Stop a background process started with start_process.

        Args:
            name: The process name given to start_process.
        """

        def go():
            if not re.fullmatch(r"[a-z0-9_-]{1,30}", name):
                return "ERROR: invalid process name."
            pid = f"/tmp/proc-{name}.pid"
            cmd = f"kill -TERM -$(cat {pid}) 2>/dev/null || kill $(cat {pid}) 2>/dev/null; echo stopped"
            _, out = sandbox.sh(uid, cmd, timeout=20)
            return out

        return run("stop_process", {"name": name}, go)

    # ---------------------------------------------------------------- safety net

    @tool
    def checkpoint(message: str) -> str:
        """Save a git commit of the whole project. Do this every time the app is in a
        working state, so changes can be rolled back and the user can export to GitHub.

        Args:
            message: Short commit message describing what now works.
        """

        def go():
            cmd = (
                "(git rev-parse --git-dir >/dev/null 2>&1 || git init -q) && git add -A && "
                f"git -c user.email=agent@appbuilder.local -c user.name=agent commit -qm {shlex.quote(message)} "
                "&& git log --oneline -1 || echo 'nothing to commit'"
            )
            _, out = sandbox.sh(uid, cmd, timeout=60)
            return out

        return run("checkpoint", {"message": message}, go)

    # ---------------------------------------------------------------- harness: planner

    @tool
    def submit_plan(summary: str, questions: list[str] | None = None) -> str:
        """Hand the plan to the user for approval. Call this last. It validates
        .orqen/spec.md, .orqen/architecture.json and .orqen/features.json.
        If the request is too vague to plan, pass up to 3 questions instead (and no files are needed).

        Args:
            summary: 2-3 sentences, plain language, describing what will be built.
            questions: Optional. Short questions for the user, each suggesting a likely default.
        """

        def go():
            if questions:
                qs = [q for q in questions if q.strip()][:3]
                ctx.plan_state = "questions"
                ctx.emit("plan", {"summary": summary, "questions": qs, "features": [], "total": 0, "passing": 0})
                return "Questions sent to the user. Finish now with the questions in plain words."
            problems, payload = harness.validate_plan(uid)
            if problems:
                return "ERROR: fix these and call submit_plan again:\n- " + "\n- ".join(problems)
            ctx.plan_state = "submitted"
            ctx.emit("plan", {"summary": summary, "questions": [], **payload})
            return f"Plan submitted with {payload['total']} features. Finish now with the summary."

        return run("submit_plan", {"summary": summary[:200]}, go)

    # ---------------------------------------------------------------- harness: builder

    @tool
    def list_features() -> str:
        """Show every planned feature with its id, whether it passes, and how to verify it."""

        def go():
            feats = harness.read_features(uid)
            if not feats:
                return "No plan yet (.orqen/features.json is missing)."
            lines = []
            for f in feats:
                mark = "PASS" if f.get("passes") else "todo"
                steps = "; ".join(f.get("steps", []))[:400]
                lines.append(f"[{mark}] {f['id']} {f.get('title', '')} :: {steps}")
            todo = len(harness.failing(feats))
            return f"{len(feats) - todo}/{len(feats)} passing\n" + "\n".join(lines)

        return run("list_features", {}, go)

    @tool
    def run_checks() -> str:
        """Run the quality gates: bash .orqen/checks.sh (typecheck, lint, tests).
        A green result is required before mark_feature(passes=true)."""

        def go():
            code, out = sandbox.sh(uid, f"test -f {harness.CHECKS} || echo __NO_CHECKS__", timeout=10)
            if "__NO_CHECKS__" in out:
                return (
                    f"ERROR: {harness.CHECKS} does not exist. Create it: a bash script with set -e that runs "
                    "the typecheck, linter and tests for every part of the app and exits non-zero on failure."
                )
            code, out = sandbox.sh(uid, f"bash {harness.CHECKS}", timeout=300)
            ok = code == 0
            ctx.checks_green = ok
            if ok:
                ctx.dirty = False
            ctx.emit("checks", {"ok": ok, "output": out[-1500:]})
            return ("PASS (exit=0)\n" if ok else f"FAIL (exit={code})\n") + out

        return run("run_checks", {}, go)

    @tool
    def mark_feature(feature_id: str, passes: bool, evidence: str) -> str:
        """Record the result of verifying one feature. passes=true is only accepted when
        run_checks is green and no files changed since. Never use this to skip work.

        Args:
            feature_id: The feature id, e.g. "F3".
            passes: True only after you verified every step of the feature against the running app.
            evidence: What you ran and saw (commands, responses), or why it could not be built.
        """

        def go():
            feats = harness.read_features(uid) or []
            match = next((f for f in feats if f.get("id") == feature_id), None)
            if not match:
                return f"ERROR: no feature with id {feature_id}. Call list_features."
            if passes and (ctx.dirty or not ctx.checks_green):
                return "ERROR: files changed since the last green run_checks (or it never passed). Run run_checks first."
            if passes and len(evidence.strip()) < 20:
                return "ERROR: give real evidence: what you ran against the app and what it returned."
            was = bool(match.get("passes"))
            match["passes"] = bool(passes)
            match["evidence"] = evidence[:1000]
            harness.write_features(uid, feats)
            if passes and not was:
                ctx.features_passed += 1
            ctx.emit("features", harness.feature_summary(feats))
            todo = harness.failing(feats)
            nxt = f" Next: {todo[0]['id']} {todo[0].get('title', '')}." if todo else " All features pass."
            return f"{feature_id} marked {'passing' if passes else 'not passing'}. {len(feats) - len(todo)}/{len(feats)} pass.{nxt}"

        return run("mark_feature", {"id": feature_id, "passes": passes}, go)

    @tool
    def add_feature(title: str, plain: str, steps: list[str], category: str = "functional") -> str:
        """Add a new feature to the plan (for a user request the plan does not cover yet).

        Args:
            title: Short technical title.
            plain: What the user gets, in plain words.
            steps: How a tester verifies it end to end.
            category: setup, functional, ui, security, data or quality.
        """

        def go():
            feats = harness.read_features(uid) or []
            nums = [int(f["id"][1:]) for f in feats if str(f.get("id", "")).startswith("F") and str(f["id"])[1:].isdigit()]
            fid = f"F{(max(nums) if nums else 0) + 1}"
            feats.append({"id": fid, "title": title, "plain": plain, "category": category, "steps": steps, "passes": False})
            harness.write_features(uid, feats)
            ctx.emit("features", harness.feature_summary(feats))
            return f"added {fid}"

        return run("add_feature", {"title": title}, go)

    @tool
    def update_progress(note: str) -> str:
        """Append a dated note to .orqen/progress.md: what you did, what is broken, what is next.
        The next session reads it first, so be specific.

        Args:
            note: A few lines of hand-off notes.
        """

        def go():
            cmd = (
                f"mkdir -p {harness.ORQEN_DIR} && printf '\\n## %s\\n%s\\n' \"$(date -u +%FT%TZ)\" "
                f"{shlex.quote(note)} >> {harness.PROGRESS} && echo saved"
            )
            _, out = sandbox.sh(uid, cmd, timeout=10)
            return out

        return run("update_progress", {"chars": len(note)}, go)

    reading = [list_dir, view_file, grep]
    if role == "planner":
        return reading + [create_file, str_replace, submit_plan]
    return reading + [
        create_file,
        str_replace,
        run_command,
        start_process,
        read_process_logs,
        stop_process,
        checkpoint,
        list_features,
        run_checks,
        mark_feature,
        add_feature,
        update_progress,
    ]
