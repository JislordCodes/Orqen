"""Agent tools. Every tool runs INSIDE the user's sandbox, never on the host.

build_tools(ctx) returns closures bound to one run (user + run id), so tools know
whose sandbox to use and where to publish events. Docstrings matter: Strands sends
them to the model as the tool descriptions.
"""
import re
import shlex

from strands import tool

from . import config, sandbox
from .events import RunContext

MAX_OUT = 6000  # characters returned to the model per tool call


def _clip(text: str, n: int = MAX_OUT) -> str:
    if len(text) <= n:
        return text
    half = n // 2
    return text[:half] + "\n...[output truncated]...\n" + text[-half:]


def build_tools(ctx: RunContext) -> list:
    uid = ctx.sandbox_id  # the sandbox is per project (user + project)

    def run(name: str, shown_input: dict, fn) -> str:
        """Common wrapper: emit events, enforce the tool budget, turn errors into text
        so the model can read them and fix its own mistakes."""
        n = ctx.next_tool_call()
        ctx.flush_text()
        ctx.emit("tool_start", {"name": name, "input": shown_input})
        if n > config.MAX_TOOL_CALLS:
            out = "STOP: tool-call budget for this run is used up. Summarize what is done and what remains, then finish."
        else:
            try:
                out = fn()
            except Exception as e:  # noqa: BLE001 - the model should see every failure
                out = f"ERROR: {e}"
        out = _clip(out)
        ctx.emit("tool_result", {"name": name, "output": out[:1500]})
        return out

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
            sandbox.write_file(uid, path, content)
            return f"wrote {path} ({len(content)} chars)"

        return run("create_file", {"path": path, "chars": len(content)}, go)

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
            text = sandbox.read_file(uid, path)
            count = text.count(old_str)
            if count == 0:
                return "ERROR: old_str not found. View the file again and copy the text exactly."
            if count > 1:
                return f"ERROR: old_str appears {count} times. Add more surrounding lines so it is unique."
            sandbox.write_file(uid, path, text.replace(old_str, new_str, 1))
            return f"edited {path}"

        return run("str_replace", {"path": path}, go)

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

    return [
        list_dir,
        view_file,
        grep,
        create_file,
        str_replace,
        run_command,
        start_process,
        read_process_logs,
        stop_process,
        checkpoint,
    ]
