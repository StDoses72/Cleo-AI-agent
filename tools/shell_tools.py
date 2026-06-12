import json
import os
import shlex
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from langchain_core.tools import tool

from config.settings import settings

VIRTUAL_WORKSPACE_PREFIX = "/workspace"
VIRTUAL_PROJECT_PREFIXES = {
    "/config": "config",
    "/core": "core",
    "/scripts": "scripts",
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


def _translate_virtual_path(value: str) -> str:
    """Translate one complete virtual path argument into a project-local path."""
    if not value:
        return value

    normalized = value.replace("\\", "/")
    mappings: list[tuple[str, Path]] = [
        (VIRTUAL_WORKSPACE_PREFIX, settings.SHELL_SANDBOX_ROOT),
        *(
            (virtual_prefix, settings.SHELL_SANDBOX_ROOT / real_child)
            for virtual_prefix, real_child in VIRTUAL_PROJECT_PREFIXES.items()
        ),
    ]
    for virtual_prefix, real_base in mappings:
        if normalized == virtual_prefix:
            return str(real_base)
        if normalized.startswith(f"{virtual_prefix}/"):
            suffix = normalized[len(virtual_prefix) + 1 :]
            return str(real_base / Path(*suffix.split("/")))
    return value


def _translate_command_args(command: str) -> list[str]:
    return [_translate_virtual_path(part) for part in _split_command(command)]


def _extract_primary_command(command: str) -> str:
    try:
        parts = _translate_command_args(command)
        if not parts:
            return ""
        return Path(parts[0].strip().strip('"').strip("'")).name
    except Exception:
        return Path((command or "").strip().split(" ")[0].strip().strip('"').strip("'")).name


def _contains_denied_pattern(command: str) -> str:
    normalized = f" {(command or '').lower()} "
    for pattern in settings.SHELL_DENIED_PATTERNS:
        if pattern.lower() in normalized:
            return pattern
    return ""


def _resolve_cwd(working_directory: str) -> Path:
    working_directory = _translate_virtual_path(_strip_matching_quotes(working_directory))
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
    now = datetime.now(UTC).isoformat()

    if not command or not command.strip():
        return "Error: command cannot be empty."

    try:
        args = _translate_command_args(command)
    except ValueError as exc:
        # shlex.split raises "No closing quotation" on an unbalanced/unclosed quote.
        # Hand a clear, actionable message back to the agent so it can re-issue the
        # command, instead of letting the exception crash the whole invoke.
        return (
            f"Error: could not parse the command ({exc}). This almost always means an "
            "unbalanced or unclosed quote in the command string. Re-issue it with matching "
            "quotes. For multi-line or quote-heavy python, write the code to a .py file and run "
            "that file, rather than a long `python -c \"...\"` one-liner with embedded quotes."
        )
    translated_command = subprocess.list2cmdline(args)
    sandbox_root = settings.SHELL_SANDBOX_ROOT
    cwd = _resolve_cwd(working_directory)
    primary = Path(args[0]).name if args else ""

    audit = {
        "timestamp_utc": now,
        "command": translated_command,
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
                "Update the active shell profile in config/cleo.json if this command is needed."
            )

    if settings.SHELL_ENFORCE_SANDBOX and not _is_inside_sandbox(cwd, sandbox_root):
        audit["reason"] = "working directory escapes sandbox root"
        audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
        _append_shell_audit(audit)
        return "Error: working directory is outside the configured sandbox root."

    try:
        env = os.environ.copy()
        env.setdefault("PYTHONUTF8", "1")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        result = subprocess.run(
            args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=settings.SHELL_TIMEOUT_SECONDS,
            shell=False,
            env=env,
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
