import asyncio

import pytest

from cleo.integrations.harnesses.codex_approvals import CodexApprovalBroker

METHOD = "mcpServer/elicitation/request"
PARAMS = {
    "threadId": "thread", "turnId": "turn", "serverName": "cua_repl",
    "mode": "form", "message": "Allow Browser use to access http://localhost:5173?",
    "requestedSchema": {"type": "object", "properties": {}},
}


@pytest.mark.parametrize("decision", ["accept", "decline", "cancel"])
def test_browser_confirmation_round_trip(decision):
    async def scenario():
        broker = CodexApprovalBroker()
        ready = asyncio.Event()
        requests = []

        async def emit(event):
            if event.type == "permission_request":
                requests.append(event.data["payload"])
                ready.set()

        broker.bind(asyncio.get_running_loop(), emit)
        response = asyncio.create_task(asyncio.to_thread(broker.handle, METHOD, PARAMS))
        try:
            await asyncio.wait_for(ready.wait(), 1)
            request = requests[0]
            assert request["kind"] == "elicitation"
            assert request["reason"] == PARAMS["message"]
            assert request["command"] == "cua_repl"
            assert request["availableDecisions"] == ["accept", "decline", "cancel"]
            await broker.resolve(request["id"], decision)
            assert await asyncio.wait_for(response, 1) == {
                "action": decision, "content": {} if decision == "accept" else None,
            }
        finally:
            broker.cancel_all()
            await response

    asyncio.run(scenario())


def test_unavailable_ui_cancels_instead_of_saving_false_denial():
    assert CodexApprovalBroker().handle(METHOD, PARAMS) == {
        "action": "cancel", "content": None,
    }


@pytest.mark.parametrize("changes", [
    {"mode": "form", "requestedSchema": {
        "type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"],
    }},
    {"mode": "openai/form", "requestedSchema": {"oneOf": []}},
    {"mode": "url", "url": "javascript:alert(1)"},
])
def test_unsupported_elicitation_is_visible_but_cannot_be_accepted(changes):
    async def scenario():
        broker = CodexApprovalBroker()
        ready = asyncio.Event()
        requests = []

        async def emit(event):
            if event.type == "permission_request":
                requests.append(event.data["payload"])
                ready.set()

        broker.bind(asyncio.get_running_loop(), emit)
        response = asyncio.create_task(asyncio.to_thread(
            broker.handle, METHOD, {**PARAMS, **changes},
        ))
        try:
            await asyncio.wait_for(ready.wait(), 1)
            request = requests[0]
            assert request["unsupportedReason"]
            assert "accept" not in request["availableDecisions"]
            with pytest.raises(ValueError, match="not available"):
                await broker.resolve(request["id"], "accept")
            broker.cancel_all()
            assert await response == {"action": "cancel", "content": None}
        finally:
            broker.cancel_all()
            await response

    asyncio.run(scenario())


def test_url_confirmation_shows_destination_and_returns_null_content():
    async def scenario():
        broker = CodexApprovalBroker()

        async def emit(event):
            if event.type == "permission_request":
                request = event.data["payload"]
                assert request["url"] == "https://example.com/authorize"
                assert request["mode"] == "url"
                await broker.resolve(request["id"], "accept")

        broker.bind(asyncio.get_running_loop(), emit)
        result = await asyncio.wait_for(asyncio.to_thread(broker.handle, METHOD, {
            **PARAMS, "mode": "url", "url": "https://example.com/authorize",
            "elicitationId": "auth-1",
        }), 1)
        assert result == {"action": "accept", "content": None}

    asyncio.run(scenario())
