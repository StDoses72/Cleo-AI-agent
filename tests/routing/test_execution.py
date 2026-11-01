import asyncio
import json
import subprocess
import sys
from unittest.mock import AsyncMock

import pytest

from cleo.routing.models import VerificationCheck


def records(service):
    return [json.loads(path.read_text()) for path in (service.state_path / "tasks").glob("*.json")]


def test_completed_is_not_accepted_and_parent_model_does_not_change(service_factory, assessment):
    async def scenario():
        service, providers = service_factory()
        original = service.store.load_manifest("parent")
        result = await service.delegate("sensitive user instruction", assessment)
        assert result["status"] == "completed" and result["acceptance"] == "unknown"
        assert service.store.load_manifest("parent") == original
        saved = records(service)[0]
        assert saved["parent_session_id"] == "parent"
        assert saved["attempts"][0]["actual_cost_usd"] is None
        assert "sensitive user instruction" not in json.dumps(saved)
        assert "Agent claims done" not in json.dumps(saved)
        assert len(providers[0].prompts) == 1 and not providers[1].prompts
        assert providers[0].closed

    asyncio.run(scenario())


def test_selected_connection_is_rechecked_before_any_prompt(service_factory, assessment):
    async def scenario():
        service, providers = service_factory()
        await service.catalog.list(str(service._project(".")))
        providers[0].behavior = "unauthenticated"
        result = await service.delegate("task", assessment)
        assert result["status"] == "failed"
        assert not providers[0].prompts and not providers[1].prompts

    asyncio.run(scenario())


def test_cancel_does_not_retry_and_records_cancellation(service_factory, assessment):
    async def scenario():
        service, providers = service_factory(behavior="wait", policy={"automatic_upgrade": True})
        running = asyncio.create_task(service.delegate("task", assessment))
        await asyncio.wait_for(providers[0].started.wait(), 10)
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running
        saved = records(service)[0]
        assert saved["status"] == "cancelled" and saved["acceptance"] == "unknown"
        assert len(saved["attempts"]) == 1 and not providers[1].prompts
        assert providers[0].closed

    asyncio.run(scenario())


def test_network_failure_is_not_a_model_upgrade_and_secrets_are_not_logged(
    service_factory, assessment
):
    async def scenario():
        service, providers = service_factory(behavior="failure", policy={"automatic_upgrade": True})
        result = await service.delegate("task", assessment)
        assert result["failure_category"] == "network" and result["attempts"] == 1
        assert not providers[1].prompts
        assert "private-test-token" not in json.dumps(records(service))

    asyncio.run(scenario())


def test_upgrade_is_bounded_and_requires_side_effect_evidence(
    service_factory, assessment, tmp_path
):
    subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(tmp_path),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
        check=True,
        capture_output=True,
    )

    async def scenario():
        service, providers = service_factory(policy={"automatic_upgrade": True})
        for policy in service.policy.candidates.values():
            policy.replay_safe_read_only = True
        # The test-only store is outside the inspected project, like production CLEO_HOME.
        project = tmp_path / "project"
        project.mkdir()
        subprocess.run(["git", "init", str(project)], check=True, capture_output=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(project),
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
            check=True,
            capture_output=True,
        )
        service.store.update_manifest("parent", cwd=str(project))
        service._verify = AsyncMock(return_value=("failed", [{"test_fixture": True}]))
        result = await service.delegate("read-only answer", assessment)
        assert result["attempts"] == 2 and result["acceptance"] == "failed"
        assert len(providers[0].prompts) == len(providers[1].prompts) == 1
        assert providers[0].prompts[0][2].sandbox == "read-only"
        assert records(service)[0]["attempts"][1]["upgrade_from"].startswith("economy/")

    asyncio.run(scenario())


def test_unknown_effects_and_explicit_choice_prevent_replay(service_factory, assessment):
    async def scenario():
        service, providers = service_factory(
            policy={"automatic_upgrade": True},
            events=[{"type": "tool_call", "text": "unknown external effect"}],
        )
        service._verify = AsyncMock(return_value=("failed", []))
        result = await service.delegate("task", assessment)
        assert result["attempts"] == 1 and not providers[1].prompts
        result = await service.delegate("task", assessment, {"provider": "economy"})
        assert result["attempts"] == 1

    asyncio.run(scenario())


def test_configured_process_check_is_real_evidence(service_factory, assessment):
    async def scenario():
        service, _ = service_factory()
        service.policy.checks = {
            "test": VerificationCheck(argv=[sys.executable, "-c", "raise SystemExit(0)"])
        }
        service.policy.checks_by_task_type = {"coding": ["test"]}
        result = await service.delegate("task", assessment)
        assert result["acceptance"] == "passed"
        assert records(service)[0]["attempts"][0]["checks"] == [{"check": "test", "exit_code": 0}]

    asyncio.run(scenario())
