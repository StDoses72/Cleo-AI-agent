"""Discover real harness/model combinations without paid model turns."""

import asyncio
import hashlib
import json
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from cleo.harnesses.availability import availability_store, provider_scope
from cleo.routing.models import Candidate, CandidatePolicy, RoutingSettings, utcnow


def candidate_id(provider: str, model: str, effort: str | None) -> str:
    """Purpose: Identify an executable combination. Input: route tuple. Output: stable ID."""
    return f"{quote(provider, safe='')}/{quote(model, safe='')}@{effort or 'default'}"


def atomic_json(path: Path, payload: dict) -> None:
    """Purpose: Publish a complete local document. Input: path/data. Output: atomic file."""
    from cleo.desktop.configuration import _atomic_write

    _atomic_write(path, payload)


class CandidateCatalog:
    def __init__(self, adapter, productivity, policy: RoutingSettings, path: Path):
        """Purpose: Bind discovery to configured harnesses. Input: services. Output: catalog."""
        self.adapter, self.productivity, self.policy, self.path = (
            adapter,
            productivity,
            policy,
            path,
        )
        self.availability = availability_store(adapter, path.parent)

    def _scope(self, name):
        """Purpose: Recompute the current connection identity without a model call."""
        return provider_scope(self.adapter.provider_control(name))

    def _fingerprint(self):
        """Purpose: Invalidate stale configuration. Input: settings. Output: opaque digest."""
        return hashlib.sha256(self.productivity.model_dump_json().encode()).hexdigest()

    async def list(self, project_path: str, *, refresh=False) -> list[Candidate]:
        """Purpose: Read cached checks or refresh metadata. Input: cwd/refresh. Output: choices.

        Discovery authenticates/lists models where supported; it never prompts a model.
        Unknown status and capabilities remain unknown, rather than inferred from API keys.
        """
        fingerprint = self._fingerprint()
        if not refresh and self.path.is_file():
            try:
                cached = json.loads(self.path.read_text(encoding="utf-8"))
                age = (utcnow() - datetime.fromisoformat(cached["checked_at"])).total_seconds()
                if (
                    cached["fingerprint"] == fingerprint
                    and cached.get("availability_version") == 1
                    and cached["project_path"] == project_path
                    and 0 <= age < self.policy.catalog_ttl_seconds
                    and all(item.get("availability_scope") == self._scope(item["provider"])
                            for item in cached["candidates"]
                            if item["provider"] in self.adapter.providers)
                ):
                    return self._apply_policy(
                        [Candidate.model_validate(item) for item in cached["candidates"]]
                    )
            except (ValueError, KeyError, TypeError):
                pass
        results = await asyncio.gather(
            *(
                self._discover(name, settings, project_path)
                for name, settings in sorted(self.productivity.providers.items())
            )
        )
        candidates = [item for group in results for item in group]
        atomic_json(
            self.path,
            {
                "fingerprint": fingerprint,
                "availability_version": 1,
                "project_path": project_path,
                "checked_at": utcnow().isoformat(),
                "candidates": [item.model_dump(mode="json") for item in candidates],
            },
        )
        return self._apply_policy(candidates)

    def _apply_policy(self, candidates):
        """Purpose: Apply current operator overrides. Input: live metadata. Output: candidates."""
        result = []
        for item in candidates:
            available, reason, source = item.available, item.status_reason, item.availability_source
            if item.availability_scope:
                evidence = self.availability.read(item.availability_scope, item.model, item.effort)
                if evidence and (evidence["available"] is False or available is None):
                    available, reason = evidence["available"], evidence["reason"]
                    source = "normal_execution"
            override = self.policy.candidates.get(
                item.id, CandidatePolicy(cost_type=item.policy.cost_type)
            )
            settings = self.productivity.providers.get(item.provider)
            result.append(
                item.model_copy(
                    update={
                        "policy": override,
                        "enabled": bool(settings and settings.enabled and override.enabled
                                        and available is True),
                        "available": available,
                        "status_reason": reason,
                        "availability_source": source,
                        "capabilities": {
                            **item.capabilities,
                            **override.capabilities,
                            **({"file_write": False} if override.replay_safe_read_only else {}),
                        },
                        "model_version": override.model_version,
                        "harness_version": override.harness_version,
                        "context_window": override.context_window or item.context_window,
                    }
                )
            )
        return result

    async def _discover(self, name, settings, project_path):
        """Purpose: Inspect one registered client. Input: provider/cwd. Output: checked models."""
        checked = utcnow()
        if not settings.enabled or name not in self.adapter.providers:
            return [self._unavailable(name, settings, checked, "disabled_or_unregistered")]
        try:
            cost_type = "unknown"
            async with asyncio.timeout(20):
                control = self.adapter.provider_control(name)
                account = getattr(control, "account_status", None)
                if callable(account):
                    status = await account()
                    if not status.authenticated:
                        return [self._unavailable(name, settings, checked, "authentication")]
                    account_type = getattr(status, "account_type", None)
                    cost_type = {"chatgpt": "subscription", "apiKey": "api", "api_key": "api"}.get(
                        account_type, "unknown"
                    )
                models = (
                    await control.list_models(project_path)
                    if settings.type in {"claude_sdk", "acp"}
                    else await self.adapter.list_models(name)
                )
        except Exception:
            # Vendor exceptions can contain URLs, credentials or prompt fragments.
            return [self._unavailable(name, settings, checked, "connection_check_failed")]
        if not models:
            return [self._unavailable(name, settings, checked, "model_capabilities_unknown")]
        capabilities = {
            "text": True,
            "shell": None,
            "file_read": None,
            "file_write": None,
            "image": None,
            "audio": None,
            "web_search": None,
            "mcp": None,
        }
        if settings.type == "codex_sdk":
            capabilities.update(shell=True, file_read=True)
            capabilities["file_write"] = settings.options.sandbox != "read-only"
        elif settings.type == "claude_sdk":
            capabilities.update(shell=True, file_read=True)
        return [
            Candidate(
                id=candidate_id(name, model.id, effort),
                connection=f"harness:{name}",
                provider=name,
                backend=settings.type,
                model=model.id,
                effort=effort,
                available=model.available,
                status_reason=None if model.available is True else (
                    "model_unsupported" if model.available is False else "account_support_unknown"
                ),
                availability_scope=self._scope(name),
                availability_source=model.availability_source,
                checked_at=checked,
                capabilities=capabilities,
                policy=CandidatePolicy(cost_type=cost_type),
            )
            for model in models
            for effort in (model.supported_efforts or (None,))
        ]

    @staticmethod
    def _unavailable(name, settings, checked, reason):
        """Purpose: Retain failed configured clients. Input: status. Output: ineligible entry."""
        return Candidate(
            id=candidate_id(name, settings.model or "default", None),
            connection=f"harness:{name}",
            provider=name,
            backend=settings.type,
            model=settings.model or "default",
            enabled=settings.enabled,
            available=False,
            checked_at=checked,
            status_reason=reason,
        )

    async def validate(self, candidate: Candidate, project_path: str) -> Candidate:
        """Purpose: Recheck only the selected route before execution. Output: actual candidate."""
        settings = self.productivity.providers.get(candidate.provider)
        if settings is None:
            raise ValueError("Selected connection no longer exists")
        current = self._apply_policy(
            await self._discover(candidate.provider, settings, project_path)
        )
        selected = next((item for item in current if item.id == candidate.id), None)
        if selected is None or not selected.enabled or selected.available is not True:
            raise ValueError("Selected connection/model/effort is no longer available")
        if selected.availability_scope != candidate.availability_scope:
            raise ValueError("Selected account/runtime changed; refresh the routing context")
        return selected
