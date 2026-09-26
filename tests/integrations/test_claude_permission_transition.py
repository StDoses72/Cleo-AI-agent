"""Regression for changing an already connected evolution session to bypass mode."""

import asyncio

import pytest

from cleo.integrations.harnesses.claude import ClaudeProvider


@pytest.mark.parametrize("resume", [None, "existing-native-session"])
def test_bypass_transition_relaunches_with_native_startup_permission(tmp_path, monkeypatch, resume):
    connections = []

    class Client:
        def __init__(self, options):
            self.options = options
            self.disconnected = False
            connections.append(self)

        async def connect(self):
            pass

        async def disconnect(self):
            self.disconnected = True

        async def set_permission_mode(self, mode):
            if mode == "bypassPermissions" and self.options.permission_mode != mode:
                raise RuntimeError("Cannot set permission mode to bypassPermissions because the "
                                   "session was not launched with --dangerously-skip-permissions")

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", Client)

    async def run():
        provider = ClaudeProvider()
        session = await provider.create_session(str(tmp_path), model="test-model")
        runtime = provider._sessions[session.id]
        runtime.native_session_id = resume
        runtime.questions.enabled = True
        await provider.update_session_options(session.id, approval_mode="bypassPermissions")
        assert len(connections) == 2
        assert connections[0].disconnected
        assert connections[1].options.permission_mode == "bypassPermissions"
        assert connections[1].options.extra_args == {"dangerously-skip-permissions": None}
        assert connections[0].options.extra_args == {}
        assert connections[1].options.resume == resume
        assert runtime.questions.enabled
        await provider.update_session_options(session.id, approval_mode="bypassPermissions")
        assert len(connections) == 2

    asyncio.run(run())


def test_cancelled_stream_is_reconnected_before_next_prompt(tmp_path, monkeypatch):
    from claude_agent_sdk import ResultMessage, SystemMessage

    connections = []
    started = asyncio.Event()

    class Client:
        def __init__(self, options):
            self.options = options
            self.closed = False
            connections.append(self)

        async def connect(self):
            pass

        async def disconnect(self):
            self.closed = True

        async def query(self, prompt):
            pass

        async def set_model(self, model):
            assert not self.closed, "Cannot change the model on a disconnected SDK stream"

        async def receive_response(self):
            yield SystemMessage(subtype="init", data={"session_id": "native-history"})
            if self is connections[0]:
                started.set()
                await asyncio.Event().wait()
            yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1,
                                is_error=False, num_turns=1,
                                session_id="native-history", result="done")

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", Client)

    async def run():
        provider = ClaudeProvider()
        session = await provider.create_session(str(tmp_path))
        task = asyncio.create_task(provider.prompt(session.id, "first"))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert connections[0].closed
        await provider.update_session_options(session.id, model="selected-after-stop")
        result = await asyncio.wait_for(provider.prompt(session.id, "second"), 1)
        assert result.response == "done"
        assert len(connections) == 2
        assert connections[1].options.resume == "native-history"
        assert connections[1].options.model == "selected-after-stop"

    asyncio.run(run())


def test_native_mode_mismatch_does_not_replace_existing_runtime(tmp_path, monkeypatch):
    connections = []

    class Client:
        def __init__(self, options):
            self.options = options
            self.closed = False
            connections.append(self)

        async def connect(self):
            pass

        async def disconnect(self):
            self.closed = True

        async def get_server_info(self):
            # Simulate a policy that refuses a permissive startup mode.
            return {"current_permission_mode": "acceptEdits"}

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", Client)

    async def scenario():
        provider = ClaudeProvider()
        session = await provider.create_session(str(tmp_path))
        with pytest.raises(ValueError, match="未应用所选权限"):
            await provider.update_session_options(session.id, approval_mode="bypassPermissions")
        assert provider.session_options(session.id).approval_mode == "acceptEdits"
        assert not connections[0].closed
        assert connections[1].closed
        assert provider._sessions[session.id].client is connections[0]
    asyncio.run(scenario())
