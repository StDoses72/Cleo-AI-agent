import asyncio
from types import SimpleNamespace

import pytest

from cleo.harnesses.questions import QuestionBroker, normalize_questions
from cleo.integrations.harnesses.codex_approvals import CodexApprovalBroker


def test_questions_require_explicit_answers_and_retry_failed_delivery():
    async def scenario():
        events = []
        fail = True

        async def emit(event):
            if fail and event.type == "question_response":
                raise RuntimeError("delivery failed")
            events.append(event)

        broker = QuestionBroker("test")
        broker.bind(emit)
        task = asyncio.create_task(
            broker.ask(
                normalize_questions(
                    [{"id": "q", "question": "Choose", "options": [{"label": "A"}]}]
                )
            )
        )
        await asyncio.sleep(0)
        request = broker.list_pending()[0]
        assert not task.done()
        with pytest.raises(ValueError):
            await broker.resolve(request["id"], {})
        with pytest.raises(RuntimeError):
            await broker.resolve(request["id"], {"q": ["custom text"]})
        assert not task.done()
        fail = False
        receipt = await broker.resolve(request["id"], {"q": ["custom text"]})
        assert await task == {"q": ["custom text"]}
        assert await broker.resolve(request["id"], {"q": ["custom text"]}) == receipt
        assert len(events) == 2
        with pytest.raises(ValueError):
            await broker.resolve(request["id"], {"q": ["A"]})

    asyncio.run(scenario())


def test_cancel_releases_waiter_without_answer_and_other_session_cannot_reply():
    async def scenario():
        broker = QuestionBroker("claude")
        other = QuestionBroker("claude")
        broker.bind(lambda _: None)
        task = asyncio.create_task(
            broker.ask(normalize_questions([{"question": "Text only"}], claude=True))
        )
        await asyncio.sleep(0)
        with pytest.raises(ValueError):
            await other.resolve(broker.list_pending()[0]["id"], {"0": ["answer"]})
        await broker.cancel_all()
        assert await task is None
        assert not broker.list_pending()

    asyncio.run(scenario())


def test_codex_native_request_does_not_use_automatic_approval():
    async def scenario():
        broker = CodexApprovalBroker()
        broker.bind(asyncio.get_running_loop(), None)
        received = asyncio.Queue()
        broker.questions.bind(received.put)
        task = asyncio.create_task(
            asyncio.to_thread(
                broker.handle,
                "item/tool/requestUserInput",
                {
                    "itemId": "native",
                    "questions": [{"id": "q", "question": "Why?"}],
                },
            )
        )
        request = await asyncio.wait_for(received.get(), 2)
        assert not task.done()
        await broker.questions.resolve(request.data["id"], {"q": ["Because"]})
        assert await task == {"answers": {"q": {"answers": ["Because"]}}}

    asyncio.run(scenario())


def test_claude_multiselect_normalization():
    question = {"id": "q", "question": "Pick", "multiSelect": True}
    assert normalize_questions([question], claude=True)[0]["multiple"]
    assert not normalize_questions([question])[0]["multiple"]


def test_duplicate_submission_waits_for_durable_answer_and_releases_only_once():
    async def scenario():
        recording = asyncio.Event()
        release = asyncio.Event()

        async def emit(event):
            if event.type == "question_response":
                recording.set()
                await release.wait()

        broker = QuestionBroker("codex")
        broker.bind(emit)
        question = asyncio.create_task(broker.ask(normalize_questions([
            {"id": "q", "question": "Choose"},
        ])))
        await asyncio.sleep(0)
        identifier = broker.list_pending()[0]["id"]
        submission = asyncio.create_task(broker.resolve(identifier, {"q": ["A"]}))
        await recording.wait()
        with pytest.raises(ValueError, match="正在提交"):
            await broker.resolve(identifier, {"q": ["A"]})
        assert not question.done()
        release.set()
        await submission
        assert await question == {"q": ["A"]}

    asyncio.run(scenario())


def test_claude_native_callback_round_trip_even_under_permissive_mode(tmp_path, monkeypatch):
    from claude_agent_sdk import PermissionResultAllow, ResultMessage

    from cleo.integrations.harnesses.claude import ClaudeProvider

    clients = []
    original = {
        "questions": [
            {
                "question": "What to change?",
                "multiSelect": True,
                "options": [{"label": "UI"}, {"label": "API"}],
            }
        ]
    }

    class Client:
        def __init__(self, options):
            self.options = options
            self.result = None
            clients.append(self)

        async def connect(self):
            pass

        async def disconnect(self):
            pass

        async def query(self, prompt):
            hook = self.options.hooks["PreToolUse"][0]
            assert hook.matcher == "AskUserQuestion"
            permission = await hook.hooks[0]({}, "call", {})
            assert permission["hookSpecificOutput"]["permissionDecision"] == "ask"

        async def receive_response(self):
            self.result = await self.options.can_use_tool(
                "AskUserQuestion",
                original,
                SimpleNamespace(tool_use_id="call"),
            )
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="native",
                result="continued",
            )

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", Client)

    async def scenario():
        provider = ClaudeProvider(permission_mode="bypassPermissions")
        session = await provider.create_session(str(tmp_path))
        await provider.enable_questions(session.id)
        events = asyncio.Queue()
        task = asyncio.create_task(provider.prompt(session.id, "work", events.put))
        request = await asyncio.wait_for(events.get(), 2)
        assert not task.done()
        await provider.resolve_question(session.id, request.data["id"], {"0": ["UI", "API"]})
        result = await asyncio.wait_for(task, 2)
        assert result.response == "continued"
        assert isinstance(clients[0].result, PermissionResultAllow)
        assert clients[0].result.updated_input == {
            **original,
            "answers": {"What to change?": "UI, API"},
        }
        await provider.close(session.id)

    asyncio.run(scenario())


def test_secret_answers_reach_provider_but_not_history():
    async def scenario():
        events = []
        broker = QuestionBroker("codex")
        broker.bind(events.append)
        task = asyncio.create_task(
            broker.ask(
                normalize_questions([{"id": "secret", "question": "Secret", "isSecret": True}])
            )
        )
        await asyncio.sleep(0)
        await broker.resolve(events[0].data["id"], {"secret": ["private value"]})
        assert await task == {"secret": ["private value"]}
        assert events[1].data["answers"] == {"secret": ["（已隐藏）"]}

    asyncio.run(scenario())


def test_disconnected_transport_releases_question_without_fabricating_an_answer():
    async def scenario():
        events = []
        alive = True
        broker = QuestionBroker("codex")
        broker.bind(events.append)
        broker.transport_alive = lambda: alive
        task = asyncio.create_task(
            broker.ask(normalize_questions([{"id": "q", "question": "Pending"}]))
        )
        await asyncio.sleep(0)
        alive = False
        assert await asyncio.wait_for(task, 1) is None
        assert events[-1].data["status"] == "unavailable"
        assert "answers" not in events[-1].data

    asyncio.run(scenario())


@pytest.mark.parametrize("cancelled", [False, True])
def test_claude_terminal_failure_preserves_progress_without_a_final_answer(cancelled):
    from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

    from cleo.harnesses.control import SessionOptions
    from cleo.integrations.harnesses.claude import ClaudeProvider, _ClaudeRuntime

    class Client:
        async def query(self, _prompt):
            pass

        async def receive_response(self):
            yield AssistantMessage(content=[TextBlock(text="Checking files")], model="test")
            yield ResultMessage(
                subtype="error_during_execution", duration_ms=1, duration_api_ms=1,
                is_error=True, num_turns=1, session_id="native", result="Stopped",
                stop_reason="cancelled" if cancelled else None,
            )

    provider = ClaudeProvider()
    provider._sessions["s"] = _ClaudeRuntime(client=Client(), options=SessionOptions(), cwd=".")
    events = []
    result = asyncio.run(provider.prompt("s", "work", events.append))
    assert result.response is None
    assert result.status == ("cancelled" if cancelled else "failed")
    assert events[0].text == "Checking files"
