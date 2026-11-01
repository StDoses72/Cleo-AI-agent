"""User presets bind main execution and routed workers without model calls."""

import asyncio
import json

import pytest

from cleo.harnesses.models import AgentEvent, emit_event
from cleo.harnesses.provider import ProviderTurn
from cleo.routing.approvals import resolve_worker_approval, watch_worker_approvals
from cleo.routing.models import RoutingSettings, load_policy, save_policy
from cleo.routing.permissions import native_permissions
from tests.desktop.test_task_questions import _service


@pytest.mark.parametrize("preset,backend,expected", [
    ("full", "codex_sdk", {"sandbox": "full-access", "approval_mode": "deny_all"}),
    ("full", "claude_sdk", {"approval_mode": "bypassPermissions"}),
    ("review", "codex_sdk", {"sandbox": "workspace-write", "approval_mode": "auto_review"}),
    ("review", "claude_sdk", {"approval_mode": "auto"}),
    ("ask", "codex_sdk", {"sandbox": "workspace-write", "approval_mode": "user"}),
    ("ask", "claude_sdk", {"approval_mode": "default"}),
])
def test_native_mapping_and_live_restrictions(preset, backend, expected):
    """Purpose: native mapping and live restrictions.

    Input: Bound offline fixtures.
    Output: Verified behavior without model calls.
    """
    assert native_permissions(backend, preset) == expected
    with pytest.raises(ValueError, match="不支持"):
        native_permissions("acp", preset)
    with pytest.raises(ValueError, match="权限不可用"):
        native_permissions(backend, preset, {"approval": {expected["approval_mode"]: "disabled"}})


def test_settings_roundtrip_keeps_the_old_base_schema(tmp_path):
    """Purpose: settings roundtrip keeps the old base schema.

    Input: Bound offline fixtures.
    Output: Verified behavior without model calls.
    """
    path = tmp_path / "routing.json"
    save_policy(path, RoutingSettings(permission_preset="full"))
    assert "permission_preset" not in json.loads(path.read_text())
    assert set(json.loads(path.with_name("routing-execution.json").read_text())) == {
        "default_mode", "evaluator",
    }
    assert json.loads(path.with_name("routing-permissions.json").read_text()) == {"preset": "full"}
    assert load_policy(path).permission_preset == "full"
    with pytest.raises(ValueError):
        RoutingSettings(permission_preset="invented")


def test_real_settings_rpc_persists_user_authority(service_factory, tmp_path):
    """Purpose: real settings rpc persists user authority.

    Input: Bound offline fixtures.
    Output: Verified behavior without model calls.
    """
    async def scenario():
        """Purpose: Exercise the enclosing behavior with offline fixtures.

        Input: Bound offline fixtures.
        Output: Verified behavior without model calls.
        """
        from tests.routing.test_desktop_settings import desktop_for

        service, providers = service_factory()
        path = tmp_path / "routing.json"
        save_policy(path, service.policy)
        desktop = desktop_for(service, tmp_path)
        view = await desktop.get_routing_settings()
        assert view["permissionPreset"] == "inherit"
        result = await desktop.save_routing_settings({
            **{key: view[key] for key in (
                "revision", "enabled", "preference", "fallbackCandidate",
            )},
            "permissionPreset": "full", "candidates": [],
        })
        assert result["permissionPreset"] == "full"
        assert load_policy(path).permission_preset == "full"
        path.with_name("routing-permissions.json").write_text('{"preset":"ask"}')
        with pytest.raises(ValueError, match="已变化"):
            await desktop.save_routing_settings({
                **{key: result[key] for key in (
                    "revision", "enabled", "preference", "fallbackCandidate",
                )}, "permissionPreset": "full", "candidates": [],
            })
        assert not any(provider.prompts for provider in providers)

    asyncio.run(scenario())


@pytest.mark.parametrize("preset", ["ask", "review", "full"])
@pytest.mark.parametrize("mode", ["auto", "manual"])
def test_main_permissions_and_handoff_use_user_preset(tmp_path, preset, mode):
    """Purpose: main permissions and handoff use user preset.

    Input: Bound offline fixtures.
    Output: Verified behavior without model calls.
    """
    async def scenario():
        """Purpose: Exercise the enclosing behavior with offline fixtures.

        Input: Bound offline fixtures.
        Output: Verified behavior without model calls.
        """
        service, provider, _ = _service(tmp_path)
        service.settings.PROFILE_DIR = tmp_path / "cleo.json"
        policy = RoutingSettings(enabled=True, permission_preset=preset)
        save_policy(tmp_path / "routing.json", policy)
        thread = await service.create_thread(
            space="productivity", project_id_value="productivity:general",
            model="gpt-test", routing_mode=mode, access="read-only", approval="user",
        )
        expected = (native_permissions("codex_sdk", preset) if mode == "auto"
                    else {"sandbox": "read-only", "approval_mode": "user"})
        options = provider.session_options("provider-new").as_dict()
        assert all(options[key] == value for key, value in expected.items())
        assert options["model"] == "gpt-test"
        assert thread["runtime"].get("routingPermissionPreset", "inherit") == (
            preset if mode == "auto" else "inherit")
        if mode == "manual":
            assert "routingPermissionPreset" not in thread["runtime"]
        if mode == "auto":
            with pytest.raises(ValueError, match="统一权限"):
                await service.update_runtime(thread_id=thread["id"], update={"approval": "user"})
            replacement = type(provider)()
            replacement.provider_type = "claude_sdk"
            child = await replacement.create_session(".")
            await service._prepare_harness(
                service.store.load_manifest(thread["id"]), "claude", replacement, child.id,
            )
            assert replacement.session_options(child.id).approval_mode == native_permissions(
                "claude_sdk", preset)["approval_mode"]
        # Explicit native controls work again when automatic routing is disabled.
        policy.enabled = False
        save_policy(tmp_path / "routing.json", policy)
        await service.update_runtime(thread_id=thread["id"], update={"approval": "user"})

    asyncio.run(scenario())


@pytest.mark.parametrize("preset", ["ask", "review", "full"])
@pytest.mark.parametrize("backend", ["codex_sdk", "claude_sdk"])
def test_delegate_uses_selected_native_options(service_factory, assessment, preset, backend):
    """Purpose: delegate uses selected native options.

    Input: Bound offline fixtures.
    Output: Verified behavior without model calls.
    """
    async def scenario():
        """Purpose: Exercise the enclosing behavior with offline fixtures.

        Input: Bound offline fixtures.
        Output: Verified behavior without model calls.
        """
        service, providers = service_factory(policy={"permission_preset": preset})
        providers[0].provider_type = backend
        if backend == "claude_sdk":
            from cleo.config.settings import ClaudeHarnessSettings

            service.productivity.providers["economy"] = ClaudeHarnessSettings(model="fixture-model")
        original = service.store.load_manifest("parent")
        result = await service.delegate("fixture task", assessment)
        assert result["status"] == "completed" and result["acceptance"] == "unknown"
        actual = providers[0].prompts[0][2].as_dict()
        expected = native_permissions(backend, preset)
        assert all(actual[key] == value for key, value in expected.items())
        assert service.store.load_manifest("parent") == original
        assert not providers[1].prompts

    asyncio.run(scenario())


def test_parent_must_apply_preset_and_running_turn_retains_snapshot(service_factory, assessment):
    """Purpose: parent must apply preset and running turn retains snapshot.

    Input: Bound offline fixtures.
    Output: Verified behavior without model calls.
    """
    async def scenario():
        """Purpose: Exercise the enclosing behavior with offline fixtures.

        Input: Bound offline fixtures.
        Output: Verified behavior without model calls.
        """
        service, providers = service_factory(policy={"permission_preset": "full"})
        service.store.update_manifest("parent", provider="economy", runtime_options={
            "model": "main-model", "sandbox": "read-only", "approval_mode": "deny_all",
        })
        decision = await service.preview(assessment)
        assert decision.selected is None
        assert "routing_permissions_not_applied_to_parent" in str(decision.rejected)
        service.store.update_manifest("parent", routing_permission_run_id="fixture-run",
                                      routing_permission_preset="ask", runtime_options={
            "model": "main-model",
            "sandbox": "workspace-write", "approval_mode": "user",
        })
        result = await service.delegate("fixture", assessment)
        assert result["status"] == "completed"
        assert providers[0].prompts[0][2].approval_mode == "user"

    asyncio.run(scenario())


@pytest.mark.parametrize("preset", ["ask", "review", "full"])
def test_unified_preset_supersedes_old_harness_pending_permissions(tmp_path, preset):
    """Purpose: Apply the current user's unified choice after a queued harness change.

    Input: Explicit global preset and pending permissions belonging to an old harness.
    Output: Selected native permissions, with stale per-harness changes cleared on success.
    """
    async def scenario():
        """Purpose: Exercise the real preparation chain. Input: Fake harness. Output: Assertions."""
        service, provider, _ = _service(tmp_path)
        service.settings.PROFILE_DIR = tmp_path / "cleo.json"
        save_policy(tmp_path / "routing.json", RoutingSettings(
            enabled=True, permission_preset=preset,
        ))
        thread = await service.create_thread(
            space="productivity", project_id_value="productivity:general", routing_mode="auto",
        )
        service.store.update_manifest(thread["id"], pending_runtime_permissions={
            "provider": "previous-harness", "options": {"approval_mode": "default"},
        })
        manifest = service.store.load_manifest(thread["id"])
        await service._apply_pending_permissions(manifest)
        await service._apply_routing_permissions(manifest, run_id="fixture-run")
        assert service.store.load_manifest(thread["id"]).get("pending_runtime_permissions") is None
        expected = native_permissions("codex_sdk", preset)
        actual = provider.session_options("provider-new").as_dict()
        assert all(actual[key] == value for key, value in expected.items())

    asyncio.run(scenario())


@pytest.mark.parametrize("mode,preset", [("manual", "full"), ("auto", "inherit")])
def test_foreign_pending_permissions_still_rejected_without_unified_choice(tmp_path, mode, preset):
    """Purpose: Preserve per-harness validation outside explicit unified routing.

    Input: Manual or inherited permissions. Output: Foreign queue rejected and retained.
    """
    async def scenario():
        """Purpose: Exercise real permission preparation with an offline harness."""
        service, _, _ = _service(tmp_path)
        service.settings.PROFILE_DIR = tmp_path / "cleo.json"
        save_policy(tmp_path / "routing.json", RoutingSettings(
            enabled=True, permission_preset=preset,
        ))
        thread = await service.create_thread(
            space="productivity", project_id_value="productivity:general", routing_mode=mode,
        )
        pending = {"provider": "previous-harness", "options": {"approval_mode": "default"}}
        service.store.update_manifest(thread["id"], pending_runtime_permissions=pending)
        with pytest.raises(ValueError, match="之前的运行后端"):
            await service._apply_pending_permissions(service.store.load_manifest(thread["id"]))
        assert service.store.load_manifest(thread["id"])["pending_runtime_permissions"] == pending

    asyncio.run(scenario())


@pytest.mark.parametrize("outcome", ["failure", "replacement"])
def test_unified_permissions_preserve_unapplied_or_newer_queue(tmp_path, monkeypatch, outcome):
    """Purpose: Guard queue cleanup against failed native updates and concurrent edits.

    Input: Failing or concurrently edited fake adapter. Output: Pending settings retained.
    """
    async def scenario():
        """Purpose: Exercise success-only cleanup without inference or real configuration writes."""
        service, _, _ = _service(tmp_path)
        service.settings.PROFILE_DIR = tmp_path / "cleo.json"
        save_policy(tmp_path / "routing.json", RoutingSettings(
            enabled=True, permission_preset="full",
        ))
        thread = await service.create_thread(
            space="productivity", project_id_value="productivity:general", routing_mode="auto",
        )
        pending = {"provider": "previous-harness", "options": {"approval_mode": "default"}}
        newer = {"provider": "next-harness", "options": {"approval_mode": "auto"}}
        service.store.update_manifest(thread["id"], pending_runtime_permissions=pending)
        manifest = service.store.load_manifest(thread["id"])

        async def update(*args, **kwargs):
            """Purpose: Simulate native failure or a new queued user edit during the await."""
            if outcome == "failure":
                raise ValueError("fixture native rejection")
            service.store.update_manifest(thread["id"], pending_runtime_permissions=newer)

        monkeypatch.setattr(service._adapter(), "update_session_options", update)
        await service._apply_pending_permissions(manifest)
        if outcome == "failure":
            with pytest.raises(ValueError, match="fixture native rejection"):
                await service._apply_routing_permissions(manifest, run_id="fixture-run")
        else:
            await service._apply_routing_permissions(manifest, run_id="fixture-run")
        latest = service.store.load_manifest(thread["id"])
        assert latest["pending_runtime_permissions"] == (pending if outcome == "failure" else newer)
        if outcome == "failure":
            assert latest.get("routing_permission_run_id") is None

    asyncio.run(scenario())


@pytest.mark.parametrize("decision", ["accept", "decline", "stale"])
def test_worker_approval_returns_via_parent_ui(service_factory, assessment, decision):
    """Purpose: worker approval returns via parent ui.

    Input: Bound offline fixtures.
    Output: Verified behavior without model calls.
    """
    async def scenario():
        """Purpose: Exercise the enclosing behavior with offline fixtures.

        Input: Bound offline fixtures.
        Output: Verified behavior without model calls.
        """
        from cleo.harnesses.approvals import PermissionBroker
        from cleo.harnesses.capabilities import Capability

        service, providers = service_factory(policy={"permission_preset": "ask"})
        service.state_path = service.store.memory_root / ".routing"
        provider = providers[0]
        broker = PermissionBroker(provider.name)
        provider.capabilities = frozenset({Capability.USER_APPROVALS})

        async def enable(_):
            """Purpose: Enable the fake native approval broker.

            Input: Bound offline fixtures.
            Output: Verified behavior without model calls.
            """
            broker.enabled = True

        async def resolve(_, identifier, answer):
            """Purpose: Return a fake native approval decision.

            Input: Bound offline fixtures.
            Output: Verified behavior without model calls.
            """
            return await broker.resolve(identifier, answer)

        async def prompt(identifier, text, on_event=None):
            """Purpose: Simulate a native permission request without inference.

            Input: Bound offline fixtures.
            Output: Verified behavior without model calls.
            """
            broker.callback = on_event
            answer = await broker.ask(broker.request(command="fixture-command"))
            assert answer == ("cancel" if decision == "stale" else decision)
            await emit_event(on_event, AgentEvent(provider=provider.name, type="status"))
            return ProviderTurn(identifier, "turn", "completed", response="fixture")

        provider.enable_user_approvals = enable
        provider.resolve_approval = resolve
        provider.prompt = prompt
        seen = []

        async def emit(event):
            """Purpose: Handle the fake parent approval event.

            Input: Bound offline fixtures.
            Output: Verified behavior without model calls.
            """
            seen.append(event)
            if event["type"] == "approval-request":
                request = event["request"]
                assert request["threadId"] == "parent"
                foreign = resolve_worker_approval(service.store, "foreign", request["id"], "accept")
                assert foreign is None
                with pytest.raises(ValueError):
                    resolve_worker_approval(service.store, "parent", request["id"], "invented")
                if decision == "stale":
                    service.store.update_manifest("parent", routing_permission_run_id="next-run")
                    with pytest.raises(ValueError, match="已结束"):
                        resolve_worker_approval(service.store, "parent", request["id"], "accept")
                    return
                receipt = resolve_worker_approval(service.store, "parent", request["id"], decision)
                assert receipt["decision"] == decision
                with pytest.raises(ValueError):
                    resolve_worker_approval(service.store, "parent", request["id"], "accept")

        async with watch_worker_approvals(service.store, "parent", emit):
            result = await asyncio.wait_for(service.delegate("fixture", assessment), 10)
        assert result["status"] == "completed"
        assert any(event["type"] == "approval-request" for event in seen)
        assert not list((service.store.memory_root / ".routing" / "approvals").glob("*.json"))

    asyncio.run(scenario())


def test_cancel_during_worker_approval_cleans_up_without_upgrade(service_factory, assessment):
    """Purpose: cancel during worker approval cleans up without upgrade.

    Input: Bound offline fixtures.
    Output: Verified behavior without model calls.
    """
    async def scenario():
        """Purpose: Exercise the enclosing behavior with offline fixtures.

        Input: Bound offline fixtures.
        Output: Verified behavior without model calls.
        """
        service, providers = service_factory(policy={
            "permission_preset": "ask", "automatic_upgrade": True,
        })
        requested = asyncio.Event()

        async def prompt(identifier, text, on_event=None):
            """Purpose: Simulate a native permission request without inference.

            Input: Bound offline fixtures.
            Output: Verified behavior without model calls.
            """
            requested.set()
            await emit_event(on_event, AgentEvent(provider="economy", type="permission_request",
                data={"id": "approval-fixture", "availableDecisions": ["accept", "cancel"]}))

        providers[0].prompt = prompt
        running = asyncio.create_task(service.delegate("fixture", assessment))
        await asyncio.wait_for(requested.wait(), 10)
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running
        assert not providers[1].prompts
        assert not list((service.store.memory_root / ".routing" / "approvals").glob("*.json"))

    asyncio.run(scenario())
