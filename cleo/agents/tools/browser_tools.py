"""Constrained agent-browser tools for Cleo's foreground agent."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import uuid4

from langchain.tools import ToolRuntime, tool

from cleo.config.settings import BrowserToolSettings, settings

_REF_PATTERN = re.compile(r"^@?e[1-9][0-9]*$")
_TAB_PATTERN = re.compile(r"^(?:t[0-9]+|[A-Za-z0-9][A-Za-z0-9_-]{0,63})$")
_SESSION_SAFE_PATTERN = re.compile(r"[^A-Za-z0-9_-]+")
_SAFE_ENVIRONMENT_KEYS = (
    "APPDATA",
    "COMSPEC",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
)
_MAX_INPUT_CHARS = 20000


class BrowserToolError(RuntimeError):
    """A browser invocation was rejected or could not be completed."""


def _browser_config() -> BrowserToolSettings:
    profile = getattr(settings, "active_tools_profile", None)
    browser = getattr(profile, "browser", None)
    if browser is None:
        raise BrowserToolError("The active tools profile has no browser configuration.")
    if not browser.enabled:
        raise BrowserToolError("Browser tools are disabled in the active tools profile.")
    return browser


def _thread_id(runtime: ToolRuntime | None) -> str:
    config = getattr(runtime, "config", None)
    configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
    value = configurable.get("thread_id", "local")
    return str(value or "local")


def _session_name(runtime: ToolRuntime | None) -> str:
    raw_thread_id = _thread_id(runtime)
    safe = _SESSION_SAFE_PATTERN.sub("-", raw_thread_id).strip("-_") or "local"
    digest = hashlib.sha256(raw_thread_id.encode("utf-8")).hexdigest()[:10]
    return f"cleo-{safe[:40]}-{digest}"


def _npm_native_binary(shim: Path) -> Path | None:
    """Resolve agent-browser's native executable without invoking a shell shim."""

    machine = platform.machine().casefold()
    if machine in {"amd64", "x86_64"}:
        architecture = "x64"
    elif machine in {"arm64", "aarch64"}:
        architecture = "arm64"
    else:
        return None

    if os.name == "nt":
        filename = f"agent-browser-win32-{architecture}.exe"
    elif platform.system() == "Darwin":
        filename = f"agent-browser-darwin-{architecture}"
    else:
        filename = f"agent-browser-linux-{architecture}"

    candidate = shim.parent / "node_modules" / "agent-browser" / "bin" / filename
    return candidate.resolve() if candidate.is_file() else None


def _command_prefix(command: str) -> list[str]:
    expanded = Path(command).expanduser()
    if expanded.parent != Path(".") or expanded.is_absolute():
        resolved = expanded.resolve()
        if not resolved.is_file():
            raise BrowserToolError(f"Configured agent-browser executable was not found: {resolved}")
    else:
        found = shutil.which(command)
        if not found and os.name == "nt" and command.casefold() in {
            "agent-browser",
            "agent-browser.cmd",
        }:
            npm_prefix = Path(os.environ.get("APPDATA", "")) / "npm"
            for filename in ("agent-browser.cmd", "agent-browser.exe"):
                candidate = npm_prefix / filename
                if candidate.is_file():
                    found = str(candidate)
                    break
        if not found:
            raise BrowserToolError(
                "agent-browser is not installed or is not on PATH. "
                "Install it with: npm install -g agent-browser@0.33.1"
            )
        resolved = Path(found).resolve()

    suffix = resolved.suffix.casefold()
    if os.name == "nt" and suffix in {".cmd", ".bat", ".ps1"}:
        native = _npm_native_binary(resolved)
        if native is None:
            raise BrowserToolError(
                "The agent-browser npm shell shim was found, but its native binary was not. "
                "Reinstall agent-browser with npm install -g agent-browser@0.33.1."
            )
        return [str(native)]
    if suffix in {".js", ".cjs", ".mjs"}:
        node = shutil.which("node")
        if not node:
            raise BrowserToolError("Node.js is required to run the agent-browser package.")
        return [node, str(resolved)]
    return [str(resolved)]


def _browser_environment(config: BrowserToolSettings) -> dict[str, str]:
    env = {key: os.environ[key] for key in _SAFE_ENVIRONMENT_KEYS if key in os.environ}
    env.update(
        {
            "AGENT_BROWSER_CONTENT_BOUNDARIES": "1",
            "AGENT_BROWSER_DEFAULT_TIMEOUT": str(config.operation_timeout_ms),
            "AGENT_BROWSER_IDLE_TIMEOUT_MS": str(config.idle_timeout_seconds * 1000),
            "AGENT_BROWSER_MAX_OUTPUT": str(config.max_output_chars),
        }
    )
    if config.allowed_domains:
        env["AGENT_BROWSER_ALLOWED_DOMAINS"] = ",".join(config.allowed_domains)
    return env


def _reject_non_public_address(address: str) -> None:
    try:
        parsed = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError as exc:
        raise BrowserToolError(f"Could not validate resolved browser address: {address}") from exc
    if not parsed.is_global:
        raise BrowserToolError(
            f"Browser navigation to non-public address {parsed} is blocked by default. "
            "Set browser.allow_private_network=true only for a trusted local target."
        )


def _validate_url(url: str, config: BrowserToolSettings) -> str:
    if not url or len(url) > 4096:
        raise BrowserToolError("Browser URL must be between 1 and 4096 characters.")

    parsed = urlsplit(url)
    if parsed.scheme.casefold() not in {"http", "https"}:
        raise BrowserToolError("Browser navigation only supports http:// and https:// URLs.")
    if not parsed.hostname:
        raise BrowserToolError("Browser URL must include a hostname.")
    if parsed.username is not None or parsed.password is not None:
        raise BrowserToolError("Browser URLs containing embedded credentials are not allowed.")
    if config.allow_private_network:
        return url

    hostname = parsed.hostname.rstrip(".").casefold()
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
        raise BrowserToolError(
            "Browser navigation to local hostnames is blocked by default. "
            "Set browser.allow_private_network=true only for a trusted local target."
        )

    try:
        literal = ipaddress.ip_address(hostname.split("%", 1)[0])
    except ValueError:
        literal = None
    if literal is not None:
        _reject_non_public_address(str(literal))
        return url

    try:
        addresses = socket.getaddrinfo(
            hostname,
            parsed.port or (443 if parsed.scheme.casefold() == "https" else 80),
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise BrowserToolError(f"Could not resolve browser hostname: {hostname}") from exc
    if not addresses:
        raise BrowserToolError(f"Could not resolve browser hostname: {hostname}")
    for address in {entry[4][0] for entry in addresses}:
        _reject_non_public_address(address)
    return url


def _normalize_ref(ref: str) -> str:
    value = ref.strip()
    if not _REF_PATTERN.fullmatch(value):
        raise BrowserToolError("Element target must be a snapshot ref such as @e3.")
    return value if value.startswith("@") else f"@{value}"


def _parse_json_output(stdout: str) -> dict[str, Any]:
    text = stdout.strip()
    if not text:
        raise BrowserToolError("agent-browser returned no JSON output.")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        lines = [line for line in text.splitlines() if line.strip()]
        try:
            parsed = json.loads(lines[-1])
        except (IndexError, json.JSONDecodeError) as exc:
            raise BrowserToolError("agent-browser returned invalid JSON output.") from exc
    if not isinstance(parsed, dict):
        raise BrowserToolError("agent-browser returned an unexpected JSON value.")
    return parsed


def _artifact_path(session: str, suffix: str) -> Path:
    root = settings.active_directory_profile.session_artifacts_path / "browser" / session
    root.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    return root / f"{stamp}-{uuid4().hex[:8]}{suffix}"


def _virtual_artifact_path(path: Path) -> str:
    project_root = settings.active_directory_profile.root_path
    try:
        relative = path.resolve().relative_to(project_root.resolve())
    except ValueError:
        return str(path.resolve())
    return "/" + relative.as_posix()


def _bound_payload(payload: dict[str, Any], action: str, session: str) -> dict[str, Any]:
    config = _browser_config()
    serialized = json.dumps(payload, ensure_ascii=False, default=str)
    if len(serialized) <= config.max_output_chars:
        return payload

    path = _artifact_path(session, f"-{action}.json")
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    preview_limit = max(config.max_output_chars - 1000, 1000)
    return {
        "success": bool(payload.get("success")),
        "truncated": True,
        "preview": serialized[:preview_limit],
        "artifact_path": _virtual_artifact_path(path),
        "message": "Full browser result was saved as a project artifact.",
    }


def _safe_stderr(stderr: str) -> str:
    compact = " ".join(stderr.strip().split())
    return compact[:1200]


def _creation_flags() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _ensure_session_started(
    command_prefix: list[str],
    session: str,
    config: BrowserToolSettings,
    environment: dict[str, str],
) -> None:
    """Start the daemon with null stdio so it cannot inherit capture pipes."""

    result = subprocess.run(
        [*command_prefix, "--session", session, "--json", "get", "url"],
        cwd=str(settings.active_directory_profile.root_path),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=config.timeout_seconds,
        shell=False,
        env=environment,
        creationflags=_creation_flags(),
    )
    if result.returncode != 0:
        raise BrowserToolError(
            "agent-browser could not start a browser session. "
            "Run 'agent-browser install' if Chrome or Edge is not available."
        )


def _run_agent_browser(
    action: str,
    args: list[str],
    runtime: ToolRuntime | None,
) -> dict[str, Any]:
    try:
        config = _browser_config()
        session = _session_name(runtime)
        command_prefix = _command_prefix(config.command)
        environment = _browser_environment(config)
        _ensure_session_started(command_prefix, session, config, environment)
        command = [
            *command_prefix,
            "--session",
            session,
            "--json",
            *args,
        ]
        result = subprocess.run(
            command,
            cwd=str(settings.active_directory_profile.root_path),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=config.timeout_seconds,
            shell=False,
            env=environment,
            creationflags=_creation_flags(),
        )
        payload = _parse_json_output(result.stdout)
        if result.returncode != 0 and payload.get("success", True):
            payload = {
                "success": False,
                "error": payload,
                "stderr": _safe_stderr(result.stderr),
            }
        return _bound_payload(payload, action, session)
    except subprocess.TimeoutExpired:
        timeout_seconds = _browser_config().timeout_seconds
        return {
            "success": False,
            "error": f"Browser operation timed out after {timeout_seconds} seconds.",
        }
    except BrowserToolError as exc:
        return {"success": False, "error": str(exc)}
    except OSError as exc:
        return {"success": False, "error": f"Could not start agent-browser: {exc}"}


@tool("browser_open")
def browser_open(url: str, runtime: ToolRuntime) -> dict[str, Any]:
    """Open a public HTTP(S) URL in this Cleo thread's isolated browser session."""

    try:
        config = _browser_config()
        safe_url = _validate_url(url, config)
    except BrowserToolError as exc:
        return {"success": False, "error": str(exc)}
    args = ["open", safe_url]
    if not config.headless:
        args.append("--headed")
    return _run_agent_browser("open", args, runtime)


@tool("browser_snapshot")
def browser_snapshot(
    interactive: bool = True,
    compact: bool = True,
    depth: int | None = None,
    runtime: ToolRuntime = None,
) -> dict[str, Any]:
    """Read the current page accessibility tree and refresh action refs such as @e3."""

    args = ["snapshot"]
    if interactive:
        args.append("-i")
    if compact:
        args.append("-c")
    if depth is not None:
        if not 1 <= depth <= 30:
            return {"success": False, "error": "Snapshot depth must be between 1 and 30."}
        args.extend(["-d", str(depth)])
    return _run_agent_browser("snapshot", args, runtime)


@tool("browser_click")
def browser_click(ref: str, runtime: ToolRuntime) -> dict[str, Any]:
    """Click an element ref from the most recent browser_snapshot result."""

    try:
        target = _normalize_ref(ref)
    except BrowserToolError as exc:
        return {"success": False, "error": str(exc)}
    return _run_agent_browser("click", ["click", target], runtime)


@tool("browser_fill")
def browser_fill(ref: str, text: str, runtime: ToolRuntime) -> dict[str, Any]:
    """Replace the value of an input identified by a recent snapshot ref."""

    try:
        target = _normalize_ref(ref)
    except BrowserToolError as exc:
        return {"success": False, "error": str(exc)}
    if len(text) > _MAX_INPUT_CHARS:
        return {"success": False, "error": "Browser input is too large."}
    return _run_agent_browser("fill", ["fill", target, text], runtime)


@tool("browser_press")
def browser_press(key: str, runtime: ToolRuntime) -> dict[str, Any]:
    """Press a browser key such as Enter, Escape, Tab, or Control+A."""

    if not key or len(key) > 64 or any(character in key for character in "\r\n\0"):
        return {"success": False, "error": "Browser key must be 1 to 64 characters."}
    return _run_agent_browser("press", ["press", key], runtime)


@tool("browser_wait")
def browser_wait(
    condition: Literal["load", "text", "url", "time"],
    value: str = "",
    timeout_seconds: int = 10,
    runtime: ToolRuntime = None,
) -> dict[str, Any]:
    """Wait for page load state, visible text, a URL pattern, or a number of seconds."""

    if not 1 <= timeout_seconds <= 120:
        return {"success": False, "error": "Wait timeout must be between 1 and 120 seconds."}
    timeout_ms = timeout_seconds * 1000
    if condition == "time":
        try:
            delay_ms = round(float(value) * 1000)
        except ValueError:
            return {"success": False, "error": "Time wait value must be seconds."}
        if not 0 <= delay_ms <= 120000:
            return {"success": False, "error": "Time wait must be between 0 and 120 seconds."}
        args = ["wait", str(delay_ms)]
    elif condition == "load":
        state = value or "networkidle"
        if state not in {"load", "domcontentloaded", "networkidle"}:
            return {"success": False, "error": "Unsupported browser load state."}
        args = ["wait", "--load", state, "--timeout", str(timeout_ms)]
    else:
        if not value or len(value) > 4096:
            return {"success": False, "error": "Wait value must be 1 to 4096 characters."}
        args = ["wait", f"--{condition}", value, "--timeout", str(timeout_ms)]
    return _run_agent_browser("wait", args, runtime)


@tool("browser_history")
def browser_history(
    action: Literal["back", "forward", "reload"],
    runtime: ToolRuntime,
) -> dict[str, Any]:
    """Go back, go forward, or reload the current browser page."""

    return _run_agent_browser(action, [action], runtime)


@tool("browser_tab")
def browser_tab(
    action: Literal["list", "new", "switch", "close"],
    target: str = "",
    url: str = "",
    label: str = "",
    runtime: ToolRuntime = None,
) -> dict[str, Any]:
    """List, open, switch, or close tabs in this Cleo thread's browser session."""

    if action == "list":
        args = ["tab"]
    elif action == "new":
        args = ["tab", "new"]
        if label:
            if not _TAB_PATTERN.fullmatch(label):
                return {"success": False, "error": "Tab label contains unsupported characters."}
            args.extend(["--label", label])
        if url:
            try:
                args.append(_validate_url(url, _browser_config()))
            except BrowserToolError as exc:
                return {"success": False, "error": str(exc)}
    elif action == "switch":
        if not _TAB_PATTERN.fullmatch(target):
            return {"success": False, "error": "Tab target must be a tab id or label."}
        args = ["tab", target]
    else:
        args = ["tab", "close"]
        if target:
            if not _TAB_PATTERN.fullmatch(target):
                return {"success": False, "error": "Tab target must be a tab id or label."}
            args.append(target)
    return _run_agent_browser(f"tab-{action}", args, runtime)


@tool("browser_screenshot")
def browser_screenshot(
    full_page: bool = False,
    annotate: bool = False,
    runtime: ToolRuntime = None,
) -> dict[str, Any]:
    """Save a screenshot under this thread's project session artifacts directory."""

    session = _session_name(runtime)
    path = _artifact_path(session, ".png")
    args = ["screenshot", str(path)]
    if full_page:
        args.append("--full")
    if annotate:
        args.append("--annotate")
    result = _run_agent_browser("screenshot", args, runtime)
    if result.get("success"):
        result["artifact_path"] = _virtual_artifact_path(path)
    return result


@tool("browser_close")
def browser_close(runtime: ToolRuntime) -> dict[str, Any]:
    """Close and remove this Cleo thread's browser session."""

    return _run_agent_browser("close", ["close"], runtime)


BROWSER_TOOLS = [
    browser_open,
    browser_snapshot,
    browser_click,
    browser_fill,
    browser_press,
    browser_wait,
    browser_history,
    browser_tab,
    browser_screenshot,
    browser_close,
]


def get_browser_tools() -> list[Any]:
    """Return browser tools only when the active profile explicitly enables them."""

    profile = getattr(settings, "active_tools_profile", None)
    browser = getattr(profile, "browser", None)
    return list(BROWSER_TOOLS) if browser is not None and browser.enabled else []
