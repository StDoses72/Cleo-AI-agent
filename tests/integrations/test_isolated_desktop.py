"""Isolation routing and manual handoff must fail closed without touching the host desktop."""

import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from cleo.computer_desktop import runtime
from cleo.integrations import computer


@pytest.mark.parametrize("output", ["", "{}", '{"ServerErrors":["pipe missing"]}',
                                    '{"ServerVersion":"29.0","OSType":"windows"}'])
def test_engine_check_rejects_exit_zero_without_a_linux_server(monkeypatch, output):
    monkeypatch.setattr(runtime, "docker", lambda *args, **kwargs: output)
    assert runtime.engine_status()["ready"] is False


def test_engine_check_accepts_verified_linux_server(monkeypatch):
    monkeypatch.setattr(runtime, "docker", lambda *args, **kwargs: json.dumps({
        "ServerVersion": "29.0.0", "OSType": "linux", "ServerErrors": [],
    }))
    assert runtime.engine_status() == {"ready": True, "version": "29.0.0"}


def test_default_desktop_routes_to_guest_without_starting_host_mcp(tmp_path, monkeypatch):
    guest = AsyncMock(return_value=[{"type": "text", "text": "guest"}])
    host = AsyncMock(side_effect=AssertionError("Host desktop must never be used"))
    monkeypatch.setattr(runtime, "invoke", guest)
    monkeypatch.setattr(computer, "connection", host)
    config = tmp_path / "computer-use.json"
    assert asyncio.run(computer.invoke("task", "Snapshot", {}, config))[0]["text"] == "guest"
    guest.assert_awaited_once_with(config, "Snapshot", {})
    guest.side_effect = ValueError("Docker unavailable")
    assert "Docker unavailable" in asyncio.run(computer.invoke("task", path=config))[0]["text"]
    host.assert_not_called()
    assert not config.exists()


def test_endpoint_requires_loopback_and_scoped_container_identity(tmp_path):
    assert runtime.identity(tmp_path / "a.json") != runtime.identity(tmp_path / "b.json")
    info = {
        "NetworkSettings": {"Ports": {"8765/tcp": [{"HostIp": "0.0.0.0", "HostPort": "1234"}]}},
        "Config": {"Env": ["CLEO_DESKTOP_TOKEN=secret"]},
    }
    with pytest.raises(ValueError, match="回环"):
        runtime.endpoint(info)
    info["NetworkSettings"]["Ports"]["8765/tcp"][0]["HostIp"] = "127.0.0.1"
    assert runtime.endpoint(info) == ("http://127.0.0.1:1234", "secret")


def test_manual_control_waits_then_resumes_and_can_be_cancelled(tmp_path, monkeypatch):
    async def run():
        info = {"guest": True}
        monkeypatch.setattr(runtime, "ensure", AsyncMock(return_value=info))
        paused = asyncio.Event()
        response = httpx.Response(409, request=httpx.Request("POST", "http://127.0.0.1/action"))
        conflict = httpx.HTTPStatusError(
            "manual control", request=response.request, response=response
        )
        manual = True

        async def request(*args, **kwargs):
            if manual:
                paused.set()
                raise conflict
            return [{"type": "text", "text": "resumed"}]

        monkeypatch.setattr(runtime, "request", request)
        pending = asyncio.create_task(runtime.invoke(tmp_path, "Snapshot"))
        await asyncio.wait_for(paused.wait(), 1)
        assert not pending.done()
        manual = False
        assert (await asyncio.wait_for(pending, 2))[0]["text"] == "resumed"
        manual = True
        paused.clear()
        pending = asyncio.create_task(runtime.invoke(tmp_path, "Click", {"x": 1, "y": 1}))
        await asyncio.wait_for(paused.wait(), 1)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending

    asyncio.run(run())
