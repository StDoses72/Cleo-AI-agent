import json
import os
import shlex
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from langchain_core.tools import tool

from cleo.config.settings import settings

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


def _translate_virtual_paths_in_command(command: str) -> str:
    translated = command
    mappings: list[tuple[str, Path]] = [
        (VIRTUAL_WORKSPACE_PREFIX, settings.SHELL_SANDBOX_ROOT),
        *(
            (virtual_prefix, settings.SHELL_SANDBOX_ROOT / real_child)
            for virtual_prefix, real_child in VIRTUAL_PROJECT_PREFIXES.items()
        ),
    ]
    for virtual_prefix, real_base in sorted(mappings, key=lambda item: len(item[0]), reverse=True):
        translated = translated.replace(virtual_prefix, str(real_base))
    return translated


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


def _resolve_cwd(working_directory: str) -> Path:
    working_directory = _translate_virtual_path(_strip_matching_quotes(working_directory))
    if not working_directory:
        return settings.SHELL_SANDBOX_ROOT

    candidate = Path(working_directory)
    if not candidate.is_absolute():
        candidate = settings.SHELL_SANDBOX_ROOT / candidate
    return candidate.resolve()


def _truncate_output(text: str) -> str:
    max_chars = settings.SHELL_MAX_OUTPUT_CHARS
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    omitted = len(text) - max_chars
    return f"{text[:max_chars]}\n\n...[truncated {omitted} chars]"


def _path_is_inside(child: Path, parent: Path) -> bool:
    try:
        child_resolved = child.resolve()
        parent_resolved = parent.resolve()
        common = os.path.commonpath([str(child_resolved), str(parent_resolved)])
    except (OSError, ValueError):
        return False
    return os.path.normcase(common) == os.path.normcase(str(parent_resolved))


def _normalized_command_names(commands: list[str]) -> set[str]:
    names: set[str] = set()
    for command in commands:
        stripped = _strip_matching_quotes(command.strip())
        if stripped:
            names.add(Path(stripped).name.casefold())
    return names


def _first_denied_pattern(command: str) -> str | None:
    command_text = command.casefold()
    for pattern in settings.SHELL_DENIED_PATTERNS:
        if pattern and pattern.casefold() in command_text:
            return pattern
    return None


def _first_outside_sandbox_path(command: str, sandbox_root: Path) -> str | None:
    for arg in _translate_command_args(command)[1:]:
        candidate = Path(_strip_matching_quotes(arg))
        if candidate.is_absolute() and not _path_is_inside(candidate, sandbox_root):
            return str(candidate)
    return None


def _blocked_shell_result(audit: dict, start: float, reason: str) -> str:
    audit["allowed"] = False
    audit["reason"] = reason
    audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
    _append_shell_audit(audit)
    return f"Command blocked by shell policy: {reason}"


@tool
def run_shell_command(command: str, working_directory: str = "") -> str:
    """
    Run a local shell command for the user.

    The tool reads its shell policy from the active shell profile. It can enforce
    an allowlist, configured denied patterns, a best-effort sandbox boundary, and
    a fail-closed approval requirement. It always records audit entries, applies
    the configured timeout, truncates oversized output, and starts in the
    configured project root when no working directory is provided.

    Args:
        command: Command string to execute. `/workspace/...`, `/skills/...`,
            and other known Deep Agents virtual paths are translated to matching
            local project paths before execution.
        working_directory: Optional working directory. Relative paths resolve
            under the configured project root.

    Returns:
        A text summary containing stdout or stderr.
    """
    start = time.perf_counter()
    now = datetime.now(UTC).isoformat()

    if not command or not command.strip():
        return "Error: command cannot be empty."

    translated_command = _translate_virtual_paths_in_command(command)
    sandbox_root = settings.SHELL_SANDBOX_ROOT
    cwd = _resolve_cwd(working_directory)
    primary = _extract_primary_command(translated_command)

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

    if settings.SHELL_REQUIRE_APPROVAL:
        return _blocked_shell_result(
            audit,
            start,
            "approval is required, but no interactive approval flow is available",
        )

    denied_pattern = _first_denied_pattern(translated_command)
    if denied_pattern is not None:
        return _blocked_shell_result(
            audit,
            start,
            f"command matched denied pattern: {denied_pattern}",
        )

    if settings.SHELL_REQUIRE_ALLOWLIST:
        allowed_commands = _normalized_command_names(settings.SHELL_ALLOWED_COMMANDS)
        if primary.casefold() not in allowed_commands:
            return _blocked_shell_result(
                audit,
                start,
                f"primary command is not in allowlist: {primary or '<empty>'}",
            )

    if settings.SHELL_ENFORCE_SANDBOX:
        if not _path_is_inside(cwd, sandbox_root):
            return _blocked_shell_result(
                audit,
                start,
                f"working directory is outside sandbox: {cwd}",
            )
        outside_path = _first_outside_sandbox_path(translated_command, sandbox_root)
        if outside_path is not None:
            return _blocked_shell_result(
                audit,
                start,
                f"absolute path argument is outside sandbox: {outside_path}",
            )

    try:
        env = os.environ.copy()
        env.setdefault("PYTHONUTF8", "1")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        if os.name == "nt":
            run_args: str | list[str] = [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                translated_command,
            ]
            use_shell = False
        else:
            run_args = translated_command
            use_shell = True

        result = subprocess.run(
            run_args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=settings.SHELL_TIMEOUT_SECONDS,
            shell=use_shell,
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
