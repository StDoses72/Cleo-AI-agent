"""Tasks the removed local-evolution feature created are still user data.

They sit in the ``cleo-evolution`` development project with the old managed source directory
as their working directory. They must keep loading and behave like any other development task,
whether or not an earlier launcher still exports ``CLEO_EVOLUTION_WORKSPACE``.
"""

import asyncio
from pathlib import Path

import pytest

from cleo.desktop.rpc import RpcRegistry
from tests.desktop.test_service import FakeAdapter, _service

REQUIREMENTS = (
    "Cleo self-iteration requirements:\n- Work only on the managed Cleo source workspace.\n"
    "- End with a concise user-facing summary.\n\nUser request:\n"
)
INTERNAL_TITLE = "Cleo self-iteration requirements: - Work only on the managed"
REMOVED_METHODS = (
    "open_evolution_thread", "is_evolution_thread", "analyze_evolution_request",
    "release_runtime",
)


def _earlier_task(service, source: Path) -> str:
    """Purpose: Write a session the way v0.12.2 left one. Output: its id."""
    store = service.store
    store.create_session(
        session_id="evolution-task", space="productivity", project="cleo-evolution",
        provider="codex", owner_type="user", native_session_id="native-evolution",
        cwd=str(source),
    )
    store.append_events(
        space="productivity", project="cleo-evolution", session_id="evolution-task",
        events=[
            {"id": "u1", "type": "user_message", "actor": "agent",
             "content": REQUIREMENTS + "把按钮放左边", "data": {}},
            {"id": "a1", "type": "assistant_message", "actor": "agent", "content": "完成"},
        ],
    )
    store.rename_session("evolution-task", INTERNAL_TITLE)
    # Fixed full access as evolution applied it, plus a field this version has never heard of.
    store.update_manifest(
        "evolution-task",
        runtime_options={"sandbox": "full-access", "approval_mode": "deny_all"},
        evolution_receipt={"keep": True},
    )
    return "evolution-task"


def _desktop(tmp_path: Path, monkeypatch, exported: bool):
    service = _service(tmp_path)
    service._adapter_instance = FakeAdapter(service.store)
    source = tmp_path / "userdata" / "evolution" / "source"
    source.mkdir(parents=True)
    if exported:
        monkeypatch.setenv("CLEO_EVOLUTION_WORKSPACE", str(source))
    else:
        monkeypatch.delenv("CLEO_EVOLUTION_WORKSPACE", raising=False)
    return service, source


@pytest.mark.parametrize("exported", [False, True])
def test_earlier_evolution_task_loads_without_rewriting_its_manifest(
    tmp_path: Path, monkeypatch, exported: bool,
) -> None:
    async def scenario() -> None:
        service, source = _desktop(tmp_path, monkeypatch, exported)
        task = _earlier_task(service, source)
        before = service.store.load_manifest(task)

        thread = await service.load_thread(thread_id=task, activate=False)
        assert thread["projectId"] == "productivity:cleo-evolution"
        # The generated instructions and the title saved from them stay folded.
        assert thread["title"] == "进化会话"
        users = [item["content"] for item in thread["items"] if item.get("role") == "user"]
        assert users == ["把按钮放左边"]

        workspace = await service.load_workspace()
        listed = next(item for item in workspace["threads"] if item["id"] == task)
        assert listed["projectId"] == "productivity:cleo-evolution"
        project = next(item for item in workspace["projects"]
                       if item["id"] == "productivity:cleo-evolution")
        assert project["path"] == str(source)

        after = service.store.load_manifest(task)
        assert after == before
        assert after["title"] == INTERNAL_TITLE
        assert after["evolution_receipt"] == {"keep": True}
        assert after["cwd"] == str(source)

    asyncio.run(scenario())


@pytest.mark.parametrize("exported", [False, True])
def test_earlier_evolution_task_is_an_ordinary_development_task(
    tmp_path: Path, monkeypatch, exported: bool,
) -> None:
    async def scenario() -> None:
        service, source = _desktop(tmp_path, monkeypatch, exported)
        task = _earlier_task(service, source)
        manifest = service.store.load_manifest(task)

        # Permissions were fixed for evolution; now they are the task's own saved choice
        # and can be changed like any other task's.
        thread = await service.load_thread(thread_id=task, activate=False)
        runtime = thread["runtime"]
        assert runtime["editable"] is True
        assert (runtime["access"], runtime["approval"]) == ("full-access", "deny_all")
        assert runtime["permissionOptions"]["access"], "permission choices are no longer withheld"

        # Local skills and message editing follow the harness, not the workspace it runs in.
        assert service._rewindable(manifest) == service._rewindable(
            {**manifest, "project": "ordinary", "cwd": str(tmp_path)})

        # The task can leave its old project for a registered one.
        target = tmp_path / "target"
        target.mkdir()
        service.runtime.register_project("productivity", "target", str(target))
        await service.move_thread(thread_id=task, project_id_value="productivity:target")
        moved = service.store.load_manifest(task)
        assert (moved["project"], moved["cwd"]) == ("target", str(target))
        assert moved["evolution_receipt"] == {"keep": True}

    asyncio.run(scenario())


def test_removed_methods_are_not_served() -> None:
    async def emit(_event):
        return None

    registry = RpcRegistry()
    assert not set(registry.names()) & set(REMOVED_METHODS)
    for name in REMOVED_METHODS:
        with pytest.raises(ValueError, match=f"^unsupported desktop method: {name}$"):
            asyncio.run(registry.dispatch(object(), name, {}, emit))

