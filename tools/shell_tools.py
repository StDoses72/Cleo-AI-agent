import json
import shlex
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from langchain_core.tools import tool

from config.settings import settings


# Maps a virtual path prefix (as seen by Deep Agents' virtual filesystem) to the
# project subdirectory it resolves to. "" means the sandbox root itself.
VIRTUAL_PREFIX_MAP = {
    "/workspace": "",
    "/config": "config",
    "/core": "core",
    "/data": "data",
    "/docs": "docs",
    "/memory": "memory",
    "/skills": "skills",
    "/tools": "tools",
}


def _append_shell_audit(record: dict) -> None:
    try:
        settings.SHELL_AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(settings.SHELL_AUDIT_LOG_PATH, "a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        # Audit logging should never crash the tool call.
        pass


def _split_command(command: str) -> list[str]:
    return [_strip_matching_quotes(part) for part in shlex.split(command, posix=False)]


def _strip_matching_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _translate_virtual_token(token: str) -> str:
    """Translate a single argument token from a virtual path to a real path.

    Only tokens that *start* with a known virtual prefix on a path boundary
    (end-of-string or a following ``/``) are translated. Real Windows paths
    (e.g. ``D:\\Supremium\\part.stl`` or ``D:/data/part.stl``), URLs, and
    relative paths are returned untouched, so a project script can still
    receive user-provided absolute file paths as arguments.

    The remainder after the prefix is rejoined with :class:`pathlib.Path`, so the
    result always uses native (Windows) separators rather than mixing ``\\`` and
    ``/``.
    """
    if not token:
        return token
    # Longest prefix first so e.g. a future "/workspace-foo" can't shadow others.
    for prefix in sorted(VIRTUAL_PREFIX_MAP, key=len, reverse=True):
        if token == prefix or token.startswith(prefix + "/"):
            child = VIRTUAL_PREFIX_MAP[prefix]
            base = (
                settings.SHELL_SANDBOX_ROOT
                if not child
                else settings.SHELL_SANDBOX_ROOT / child
            )
            rest = token[len(prefix):].lstrip("/")
            if rest:
                return str(base.joinpath(*PurePosixPath(rest).parts))
            return str(base)
    return token


def _contains_denied_pattern(command: str) -> str:
    normalized = f" {(command or '').lower()} "
    for pattern in settings.SHELL_DENIED_PATTERNS:
        if pattern.lower() in normalized:
            return pattern
    return ""


def _resolve_cwd(working_directory: str) -> Path:
    working_directory = _translate_virtual_token(working_directory)
    if not working_directory:
        return settings.SHELL_SANDBOX_ROOT

    candidate = Path(working_directory)
    if not candidate.is_absolute():
        candidate = settings.SHELL_SANDBOX_ROOT / candidate
    return candidate.resolve()


def _is_inside_sandbox(path: Path, sandbox_root: Path) -> bool:
    try:
        path.resolve().relative_to(sandbox_root.resolve())
        return True
    except Exception:
        return False


def _truncate_output(text: str) -> str:
    max_chars = settings.SHELL_MAX_OUTPUT_CHARS
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    omitted = len(text) - max_chars
    return f"{text[:max_chars]}\n\n...[truncated {omitted} chars]"


@tool
def run_shell_command(command: str, working_directory: str = "") -> str:
    """
    Run an allowlisted project command in a sandboxed working directory.

    Use this tool only for project-local scripts and diagnostics that the user
    or a skill explicitly needs. The command must start with an allowlisted
    executable such as `python` or `py`, and the working directory must stay
    inside `SHELL_SANDBOX_ROOT`.

    The sandbox applies to the process working directory, not to read-only
    input file arguments. A project script may receive a user-provided absolute
    Windows file path such as `D:\\Supremium\\part.stl` when that script is
    designed to validate and read the file. Do not rewrite Windows paths to
    `/workspace` before passing them as script arguments.

    Args:
        command: Command string to execute. Shell chaining, redirects, pipes,
            and path traversal patterns are denied. `/workspace/...` command
            paths are translated to the project root for compatibility with
            Deep Agents' virtual filesystem view. `/skills/...` and other
            project virtual paths are translated to the matching project
            subdirectory. Quote Windows absolute path arguments when they
            contain spaces.
        working_directory: Optional working directory. Relative paths resolve
            under `SHELL_SANDBOX_ROOT`.

    Returns:
        A text summary containing stdout or stderr.
    """
    start = time.perf_counter()
    now = datetime.now(timezone.utc).isoformat()

    if not command or not command.strip():
        return "Error: command cannot be empty."

    sandbox_root = settings.SHELL_SANDBOX_ROOT
    cwd = _resolve_cwd(working_directory)

    # Tokenize first, then translate each token only if it is a genuine virtual
    # path. Real Windows paths / URLs passed as arguments are left untouched.
    raw_args = _split_command(command)
    args = [_translate_virtual_token(part) for part in raw_args]
    primary = Path(args[0]).name if args else ""

    audit = {
        "timestamp_utc": now,
        "command": command,
        "translated_args": args,
        "primary_command": primary,
        "working_directory": str(cwd),
        "sandbox_root": str(sandbox_root),
        "allowed": False,
        "reason": "",
        "returncode": None,
        "duration_ms": None,
    }

    denied = _contains_denied_pattern(command)
    if denied:
        audit["reason"] = f"blocked by denylist pattern: {denied}"
        audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
        _append_shell_audit(audit)
        return f"Error: command blocked by denylist pattern '{denied}'."

    if settings.SHELL_REQUIRE_ALLOWLIST:
        allowed = {item.lower() for item in settings.SHELL_ALLOWED_COMMANDS}
        if not primary or primary.lower() not in allowed:
            audit["reason"] = f"primary command '{primary}' is not in allowlist"
            audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
            _append_shell_audit(audit)
            return (
                f"Error: command '{primary}' is not allowlisted. "
                "Update SHELL_ALLOWED_COMMANDS in .env if this command is needed."
            )

    if settings.SHELL_ENFORCE_SANDBOX and not _is_inside_sandbox(cwd, sandbox_root):
        audit["reason"] = "working directory escapes sandbox root"
        audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
        _append_shell_audit(audit)
        return "Error: working directory is outside the configured sandbox root."

    try:
        result = subprocess.run(
            args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=settings.SHELL_TIMEOUT_SECONDS,
            shell=False,
        )

        audit["allowed"] = True
        audit["returncode"] = result.returncode
        audit["reason"] = "executed"
        audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
        _append_shell_audit(audit)

        stdout = _truncate_output(result.stdout or "")
        stderr = _truncate_output(result.stderr or "")

        if result.returncode == 0:
            return f"Command executed successfully.\n\nstdout:\n{stdout}"
        return (
            f"Command exited with code {result.returncode}.\n\n"
            f"stdout:\n{stdout}\n\nstderr:\n{stderr}"
        )
    except subprocess.TimeoutExpired:
        audit["reason"] = f"timeout after {settings.SHELL_TIMEOUT_SECONDS}s"
        audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
        _append_shell_audit(audit)
        return f"Error: command timed out after {settings.SHELL_TIMEOUT_SECONDS} seconds."
    except Exception as exc:
        audit["reason"] = f"execution exception: {str(exc)}"
        audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
        _append_shell_audit(audit)
        return f"Error happens in running the command: {str(exc)}"
