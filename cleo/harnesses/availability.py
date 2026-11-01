"""Account-scoped evidence from metadata and ordinary turns; never inference probes."""
import hashlib
import json
import os
import re
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace


@lru_cache(maxsize=32)
def _binary_digest(path: str, size: int, modified: int) -> str:
    """Purpose: Identify runtime bytes across install paths. Output: cached content digest."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def runtime_identity(family: str | None, executable: str | None = None) -> str | None:
    """Purpose: Scope support to the actual CLI, without spawning inference or a CLI turn.

    Input: Harness family and optional resolved command. Output: content identity or unknown.
    """
    if family is None:
        return None
    try:
        if executable is None and family == "codex":
            from codex_cli_bin import bundled_codex_path

            executable = os.environ.get("CLEO_CODEX_BIN") or str(bundled_codex_path())
        elif executable is None and family == "claude":
            import claude_agent_sdk

            executable = str(Path(claude_agent_sdk.__file__).parent / "_bundled" /
                             ("claude.exe" if os.name == "nt" else "claude"))
        path = Path(executable).resolve()
        stat = path.stat()
        return _binary_digest(str(path), stat.st_size, stat.st_mtime_ns)
    except (OSError, TypeError, ImportError):
        return "runtime_unknown"


def provider_scope(provider) -> str:
    """Purpose: Isolate evidence by connection/account without persisting credentials.

    Input: Registered provider and its configuration identity. Output: opaque SHA-256.
    """
    identity = getattr(provider, "availability_identity", None)
    provider_type = getattr(provider, "provider_type", "unknown")
    family = {"codex_sdk": "codex", "claude_sdk": "claude"}.get(provider_type)
    if identity is None and family:
        from cleo.integrations.harness_home import harness_home

        home = harness_home(family, create=False)
        try:
            if family == "codex":
                auth = json.loads((home / "auth.json").read_text(encoding="utf-8"))
                identity = (auth.get("tokens") or {}).get("account_id")
                identity = identity or auth.get("OPENAI_API_KEY") or "unidentified-account"
            else:
                auth = json.loads((home / ".claude.json").read_text(encoding="utf-8"))
                identity = (auth.get("oauthAccount") or {}).get("accountUuid")
        except (OSError, ValueError, TypeError, AttributeError):
            identity = None
        if not identity:
            key = "OPENAI_API_KEY" if family == "codex" else "ANTHROPIC_API_KEY"
            identity = os.environ.get(key) or f"unidentified:{home}"
    runtime = getattr(provider, "availability_runtime", None) or runtime_identity(family)
    payload = ["support-v2", family or provider.name, provider_type, identity, runtime,
               getattr(provider, "availability_configuration", None)]
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def unsupported_reason(error: str | None, model: str, effort: str | None = None) -> str | None:
    """Purpose: Recognize explicit model/effort rejections, not generic 400s or outages.

    Input: Provider error and the actual selection. Output: safe reason code or None.
    """
    text = error or ""
    # JSON wrappers are common; inspect only their message, never persist vendor text.
    try:
        payload = json.loads(text)
        detail = payload.get("error", payload)
        text = detail.get("message", "") if isinstance(detail, dict) else ""
    except (ValueError, TypeError, AttributeError):
        pass
    normalized = text.lower()
    quoted = re.findall(r"['\"]([^'\"]+)['\"]", normalized)
    if effort and "effort" in normalized and effort.lower() in quoted and any(
        term in normalized for term in ("not supported", "unsupported", "not allowed")
    ):
        return "effort_unsupported"
    if model.lower() not in quoted:
        return None
    if re.search(r"(?:model.{0,100}(?:not supported|unsupported|not available|does not exist)|"
                 r"(?:unsupported|unknown|invalid) model)", normalized):
        return "model_unsupported"
    return None


class ModelAvailability:
    """One file per combination avoids cross-process lost updates between different models."""

    def __init__(self, root: Path):
        """Purpose: Bind an existing memory root. Output: a lazily created evidence directory."""
        self.root = Path(root) / "availability"

    def _path(self, scope, model, effort, *, rejected=False):
        """Purpose: Keep denials separate from late successful concurrent turns."""
        key = hashlib.sha256(json.dumps([scope, model, effort, rejected]).encode()).hexdigest()
        return self.root / f"{key}.json"

    def read(self, scope, model, effort):
        """Purpose: Retain rejections across refresh/restart. Output: scoped evidence or None."""
        for level, rejected in (("*", True), (effort, True), (effort, False)):
            path = self._path(scope, model, level, rejected=rejected)
            if not path.exists():
                continue
            try:
                item = json.loads(path.read_text(encoding="utf-8"))
                if item.get("scope") != scope or item.get("model") != model:
                    raise ValueError("Invalid evidence scope")
                if not isinstance(item.get("available"), bool):
                    raise ValueError("Invalid availability")
                return item
            except (OSError, ValueError, TypeError, AttributeError):
                return {"available": False, "reason": "availability_evidence_unreadable"}
        return None

    def record(self, scope, model, effort, *, available, reason):
        """Purpose: Record only observed normal execution outcomes. Output: atomic safe metadata."""
        from cleo.desktop.configuration import _atomic_write

        payload = {"scope": scope, "model": model, "effort": effort,
                   "available": available, "reason": reason,
                   "checked_at": datetime.now(UTC).isoformat()}
        self.root.mkdir(parents=True, exist_ok=True)
        _atomic_write(self._path(scope, model, effort, rejected=not available), payload)


def availability_store(adapter, fallback: Path) -> ModelAvailability:
    """Purpose: Share main/child/desktop evidence. Output: the same memory-owned store."""
    memory = getattr(getattr(adapter, "_store", None), "memory_root", None)
    return ModelAvailability(Path(memory) / ".routing" if memory else fallback)


def profile_scope(profile) -> str:
    """Purpose: Share subscription-chat/evaluator evidence with the same harness account."""
    family = {"codex": "codex", "claude_code": "claude"}.get(profile.backend)
    executable = None
    if family == "claude":
        from cleo.integrations.subscriptions import executable as resolve_executable

        try:
            executable = resolve_executable(profile)
        except FileNotFoundError:
            executable = "unavailable-runtime"
    # Codex's provider transport uses the bundled/override CLI even for chat profiles.
    return provider_scope(SimpleNamespace(
        name=profile.provider,
        provider_type={"codex": "codex_sdk", "claude_code": "claude_sdk"}.get(
            profile.backend, profile.backend,
        ),
        availability_runtime=runtime_identity(family, executable),
    ))


def display_execution_error(error: str) -> str:
    """Purpose: Explain a rejected combination without claiming global model unavailability."""
    if "model_unsupported:" in error:
        return "当前账号与 harness 运行路径已拒绝这个模型配置，请刷新目录并选择其他可用配置。"
    if "not supported when using Codex with a ChatGPT account" in error:
        return ("当前 Codex 运行路径与登录组合拒绝了所选模型。请检查 CLI 版本和模型目录；"
                "这不代表该模型在其他客户端或账号中也不可用。")
    return error


async def observed_turn(store, scope, model, effort, operation):
    """Purpose: Guard a normal turn and retain only model-support facts, never replay it.

    Input: Evidence store, connection scope, actual model/effort and async operation.
    Output: The original result/exception; cancellation and unrelated failures add no rejection.
    """
    if not model or model == "default":
        return await operation()
    previous = store.read(scope, model, effort)
    if previous and previous["available"] is False:
        raise ValueError("model_unsupported: 当前账号与 harness 已拒绝该配置，请选择其他配置。")
    try:
        result = await operation()
    except Exception as error:
        reason = unsupported_reason(str(error), model, effort)
        if reason:
            store.record(scope, model, "*" if reason == "model_unsupported" else effort,
                         available=False, reason=reason)
        raise
    reason = unsupported_reason(getattr(result, "error", None), model, effort)
    if reason:
        store.record(scope, model, "*" if reason == "model_unsupported" else effort,
                     available=False, reason=reason)
    elif getattr(result, "status", None) == "completed" and not getattr(result, "error", None):
        store.record(scope, model, effort, available=True, reason="execution_completed")
    return result
