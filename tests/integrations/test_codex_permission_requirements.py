import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from openai_codex import Sandbox
from openai_codex.generated.v2_all import ConfigRequirementsReadResponse

from cleo.harnesses.control import SessionOptions
from cleo.integrations.harnesses.codex import CodexProvider, _CodexRuntime


@pytest.mark.parametrize("rules,update,allowed", [
    ({"allowedSandboxModes": ["workspace-write"]}, {"sandbox": "full-access"}, False),
    ({"allowedSandboxModes": ["danger-full-access"]}, {"sandbox": "full-access"}, True),
    ({"allowedApprovalPolicies": ["never"]}, {"approval_mode": "user"}, False),
    ({"allowedApprovalPolicies": ["on-request"]}, {"approval_mode": "auto_review"}, True),
    ({"featureRequirements": {"guardian_approval": False}},
     {"approval_mode": "auto_review"}, False),
    (None, {"sandbox": "full-access", "approval_mode": "user"}, True),
])
def test_native_admin_requirements_checked_before_persisting(rules, update, allowed):
    async def scenario():
        read = AsyncMock(return_value=ConfigRequirementsReadResponse.model_validate({
            "requirements": rules,
        }))
        original = SessionOptions(sandbox="workspace-write", approval_mode="deny_all")
        runtime = _CodexRuntime(SimpleNamespace(_client=SimpleNamespace(request=read)),
                                SimpleNamespace(), options=original)
        provider = CodexProvider(None)
        provider._sessions["thread"] = runtime
        if allowed:
            result = await provider.update_session_options("thread", **update)
            for key, value in update.items():
                assert getattr(result, key) == value
        else:
            with pytest.raises(ValueError, match="管理策略"):
                await provider.update_session_options("thread", **update)
            assert runtime.options == original
        read.assert_awaited_once_with(
            "configRequirements/read", None, response_model=ConfigRequirementsReadResponse,
        )
    asyncio.run(scenario())


@pytest.mark.parametrize("operation", ["create", "resume", "fork"])
@pytest.mark.parametrize("sandbox", list(Sandbox))
def test_manual_policy_is_passed_at_native_thread_creation(operation, sandbox):
    async def scenario():
        native = SimpleNamespace(**{
            name: AsyncMock(return_value=SimpleNamespace(thread=SimpleNamespace(id="native")))
            for name in ("thread_start", "thread_resume", "thread_fork")
        })

        class Client:
            _client = native
            _ensure_initialized = AsyncMock()
            close = AsyncMock()

            async def __aenter__(self):
                return self

        client = Client()
        provider = CodexProvider("model", approval_mode="user", sandbox=sandbox)
        provider._client_with_approvals = lambda _: client
        if operation == "create":
            await provider.create_session("C:/workspace")
            sent = native.thread_start.call_args.args[0]
        elif operation == "resume":
            await provider.resume_session("existing", "C:/workspace")
            sent = native.thread_resume.call_args.args[1]
        else:
            provider._sessions["existing"] = _CodexRuntime(
                client, SimpleNamespace(id="existing"),
                options=SessionOptions(model="model", sandbox=sandbox.value, approval_mode="user"),
                cwd="C:/workspace",
            )
            await provider.fork_session("existing")
            sent = native.thread_fork.call_args.args[1]
        assert sent["approvalPolicy"] == "on-request"
        assert sent["approvalsReviewer"] == "user"
        assert sent["sandbox"] == (
            "danger-full-access" if sandbox is Sandbox.full_access else sandbox.value
        )
        assert provider.session_options("native").approval_mode == "user"
    asyncio.run(scenario())
