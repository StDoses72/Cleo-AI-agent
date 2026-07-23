from pathlib import Path

import pytest
from openai_codex import ApprovalMode, Sandbox
from pydantic import ValidationError

from cleo.config.settings import ProductivitySettings, load_settings
from cleo.integrations.harnesses.acp import AcpProvider
from cleo.integrations.harnesses.claude import ClaudeProvider
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.integrations.harnesses.factory import build_agent_adapter, create_provider

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_ROOT = PROJECT_ROOT / "cleo" / "config" / "templates"


def test_separate_harnesses_config_loads_into_runtime_settings() -> None:
    settings = load_settings(
        TEMPLATE_ROOT / "cleo.example.json",
        TEMPLATE_ROOT / "harnesses.example.json",
    )

    assert settings.productivity.default_provider == "codex"
    assert settings.productivity.provider("codex").type == "codex_sdk"


def test_factory_builds_configured_provider_types(tmp_path: Path) -> None:
    productivity = ProductivitySettings.model_validate(
        {
            "default_provider": "codex",
            "providers": {
                "codex": {
                    "type": "codex_sdk",
                    "model": "gpt-test",
                    "options": {
                        "approval_mode": "auto_review",
                        "sandbox": "read-only",
                    },
                },
                "claude": {
                    "type": "claude_sdk",
                    "model": "claude-test",
                    "options": {"permission_mode": "plan"},
                },
                "acp-test": {
                    "type": "acp",
                    "options": {
                        "command": "agent-command",
                        "args": ["--acp"],
                        "auto_approve": True,
                    },
                },
                "disabled": {
                    "type": "claude_sdk",
                    "enabled": False,
                },
            },
        }
    )

    adapter = build_agent_adapter(tmp_path, productivity)

    assert adapter.providers == ("codex", "claude", "acp-test")
    codex = create_provider("codex", productivity.provider("codex"))
    claude = create_provider("claude", productivity.provider("claude"))
    acp = create_provider("acp-test", productivity.provider("acp-test"))
    assert isinstance(codex, CodexProvider)
    assert codex._default_model == "gpt-test"
    assert codex._approval_mode is ApprovalMode.auto_review
    assert codex._sandbox is Sandbox.read_only
    assert isinstance(claude, ClaudeProvider)
    assert claude._default_model == "claude-test"
    assert claude._permission_mode == "plan"
    assert isinstance(acp, AcpProvider)
    assert acp._spec.command == "agent-command"
    assert acp._spec.args == ("--acp",)


@pytest.mark.parametrize(
    "payload",
    [
        {
            "default_provider": "missing",
            "providers": {"codex": {"type": "codex_sdk"}},
        },
        {
            "default_provider": "codex",
            "providers": {
                "codex": {"type": "codex_sdk", "enabled": False},
            },
        },
    ],
)
def test_productivity_default_provider_must_be_enabled(payload: dict) -> None:
    with pytest.raises(ValidationError):
        ProductivitySettings.model_validate(payload)
