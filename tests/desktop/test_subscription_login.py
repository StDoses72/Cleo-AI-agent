import asyncio
from types import SimpleNamespace

import pytest

from cleo.config.settings import AgentProfile
from cleo.desktop.subscription_login import SubscriptionLogins
from cleo.integrations.subscriptions import AgentMcp


def test_login_cancel_closes_official_attempt_and_prevents_overlapping_logins(
    tmp_path, monkeypatch
):
    events = []

    class Login:
        auth_url = "https://auth.openai.com/test-login"

        async def wait(self):
            await asyncio.Future()

        async def cancel(self):
            events.append("cancelled")

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            events.append("closed")

        async def login_chatgpt(self):
            return Login()

    monkeypatch.setattr("openai_codex.AsyncCodex", Client)
    monkeypatch.setattr(AgentMcp, "codex_config", lambda _: None)

    async def exercise():
        logins = SubscriptionLogins()
        profile = AgentProfile(backend="codex", provider="codex", model="default")
        attempt = logins.start(profile, tmp_path)
        await asyncio.sleep(0)
        assert logins.read(attempt["id"])["url"] == Login.auth_url
        with pytest.raises(ValueError, match="登录"):
            logins.start(profile, tmp_path)
        cancelled = await logins.cancel(attempt["id"])
        assert cancelled["status"] == "cancelled"
        await logins.close()

    asyncio.run(exercise())
    assert events == ["cancelled", "closed"]


def test_login_protocol_failure_does_not_return_raw_exception(tmp_path, monkeypatch):
    async def connect(_path):
        raise Exception("private protocol payload")

    monkeypatch.setattr(
        "cleo.desktop.subscription_login.create_runtime",
        lambda *_: SimpleNamespace(
            _connect=connect,
        ),
    )

    async def exercise():
        logins = SubscriptionLogins()
        profile = AgentProfile(backend="gemini", provider="gemini", model="default")
        attempt = logins.start(profile, tmp_path)
        await asyncio.sleep(0)
        result = logins.read(attempt["id"])
        assert result["status"] == "failed"
        assert "private" not in result["output"]
        await logins.close()

    asyncio.run(exercise())
