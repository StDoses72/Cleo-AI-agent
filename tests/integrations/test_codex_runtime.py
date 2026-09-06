from openai_codex import CodexConfig

from cleo.integrations.harnesses.codex import CodexProvider


def test_desktop_cli_override_preserves_memory_configuration(monkeypatch, tmp_path):
    executable = str(tmp_path / "codex.exe")
    config = CodexConfig(config_overrides=("mcp_servers.cleo_memory.enabled=true",))
    monkeypatch.setenv("CLEO_CODEX_BIN", executable)
    monkeypatch.setattr("cleo.integrations.harnesses.codex.AsyncCodex", lambda **kwargs: kwargs)
    result = CodexProvider._client(config)
    assert result["config"].codex_bin == executable
    assert result["config"].config_overrides == ("mcp_servers.cleo_memory.enabled=true",)


def test_without_desktop_override_sdk_uses_its_bundled_cli(monkeypatch):
    monkeypatch.delenv("CLEO_CODEX_BIN", raising=False)
    monkeypatch.setattr("cleo.integrations.harnesses.codex.AsyncCodex", lambda **kwargs: kwargs)
    assert CodexProvider._client() == {}
