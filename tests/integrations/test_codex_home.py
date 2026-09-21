import asyncio
import os
import tomllib
from types import SimpleNamespace

import pytest
from openai_codex import CodexConfig
from openai_codex.errors import JsonRpcError

from cleo.integrations.codex_home import isolated_codex_config
from cleo.integrations.harnesses.codex import CodexProvider


def test_isolation_preserves_shared_config_and_does_not_copy_auth(tmp_path, monkeypatch):
    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path / "cleo")
    shared = tmp_path / "shared"
    shared.mkdir()
    (shared / "auth.json").write_text("private login sentinel")
    monkeypatch.setenv("CODEX_HOME", str(shared))
    monkeypatch.setenv("CODEX_SQLITE_HOME", str(shared))
    original = CodexConfig(env={"CUSTOM": "keep"}, config_overrides=('sqlite_home="shared"',))
    isolated = isolated_codex_config(original)
    home = (tmp_path / "cleo/data/codex").resolve()
    assert home.is_dir() and not (home / "auth.json").exists()
    assert isolated.env == {"CUSTOM": "keep", "CODEX_HOME": str(home),
                            "CODEX_SQLITE_HOME": str(home)}
    assert tomllib.loads(isolated.config_overrides[-1])["sqlite_home"] == str(home)
    assert original.env == {"CUSTOM": "keep"}
    assert original.config_overrides == ('sqlite_home="shared"',)
    assert os.environ["CODEX_HOME"] == str(shared)
    assert os.environ["CODEX_SQLITE_HOME"] == str(shared)
    assert (shared / "auth.json").read_text() == "private login sentinel"


@pytest.mark.parametrize("approval", ["deny_all", "user"])
def test_new_sessions_are_private_and_old_sessions_and_forks_keep_their_home(approval):
    async def scenario():
        stored = {False: set(), True: {"old"}}
        calls = []

        class Client:
            def __init__(self, legacy):
                self.legacy = legacy
                self._client = self

            async def __aenter__(self):
                return self

            async def _ensure_initialized(self):
                pass

            async def close(self):
                calls.append(("close", self.legacy))

            async def thread_start(self, *args, **kwargs):
                calls.append(("start", self.legacy))
                stored[self.legacy].add("new")
                thread = SimpleNamespace(id="new")
                return SimpleNamespace(thread=thread) if args else thread

            async def thread_resume(self, identifier, *args, **kwargs):
                calls.append(("resume", self.legacy))
                if identifier not in stored[self.legacy]:
                    raise JsonRpcError(-32600, f"no rollout found for thread id {identifier}")
                thread = SimpleNamespace(id=identifier)
                return SimpleNamespace(thread=thread) if args else thread

            async def thread_fork(self, identifier, *args, **kwargs):
                assert identifier in stored[self.legacy]
                calls.append(("fork", self.legacy))
                thread = SimpleNamespace(id=f"fork-{identifier}")
                return SimpleNamespace(thread=thread) if args else thread

        provider = CodexProvider(None, approval_mode=approval)
        provider._client_with_approvals = lambda _, legacy=False, **kw: Client(legacy)
        created = await provider.create_session("workspace")
        await provider.close(created.id)
        await provider.resume_session("new", "workspace")
        assert calls[-1] == ("resume", False)
        await provider.fork_session("new")
        assert calls[-1] == ("fork", False)
        await provider.resume_session("old", "workspace")
        assert calls[-3:] == [("resume", False), ("close", False), ("resume", True)]
        await provider.fork_session("old")
        assert calls[-1] == ("fork", True)
        assert stored[True] == {"old"}

    asyncio.run(scenario())


def test_authentication_error_does_not_fall_back_to_shared_codex():
    async def scenario():
        calls = []

        class Client:
            async def __aenter__(self):
                return self

            async def close(self):
                calls.append("closed")

            async def thread_resume(self, *args, **kwargs):
                raise JsonRpcError(-32000, "authentication failed")

        provider = CodexProvider(None)
        provider._client_with_approvals = lambda _, **kw: (calls.append(kw) or Client())
        with pytest.raises(JsonRpcError, match="authentication failed"):
            await provider.resume_session("id", "workspace")
        assert calls == [{}, "closed"]

    asyncio.run(scenario())
