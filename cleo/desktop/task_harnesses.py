"""Task choices with additive registration in the existing harness configuration."""

import json
from pathlib import Path

from cleo.config.settings import (
    AcpHarnessOptions,
    AcpHarnessSettings,
    ClaudeHarnessSettings,
    ProductivityProviderSettings,
    ProductivitySettings,
)


def task_providers(settings: ProductivitySettings) -> dict[str, ProductivityProviderSettings]:
    """Purpose: Expose built-in coding harnesses in development and evolution.

    Input: Existing harness settings, including explicit disabled entries.
    Output: A new mapping; saved names, options and enabled flags take precedence.
    """
    builtins: dict[str, ProductivityProviderSettings] = {
        "claude": ClaudeHarnessSettings(),
        **{
            name: AcpHarnessSettings(options=AcpHarnessOptions(command=name, args=args))
            for name, args in {
                "gemini": ["--acp"],
                "copilot": ["--acp", "--stdio"],
                "grok": ["agent", "stdio"],
                "opencode": ["acp"],
            }.items()
        },
    }
    return {**settings.providers, **{
        name: provider for name, provider in builtins.items() if name not in settings.providers
    }}


def register_task_provider(path: Path, name: str, provider: ProductivityProviderSettings) -> None:
    """Purpose: Make a newly selected harness recognizable to previous program versions.

    Input: Existing harnesses.json, selected preset name and existing-schema settings.
    Output: Atomically add one entry; unreadable/newer data and existing entries stay intact.
    """
    from cleo.desktop.configuration import _atomic_write

    raw = json.loads(path.read_text(encoding="utf-8"))
    # Refuse unknown schemas rather than serializing them through lossy model defaults.
    current = ProductivitySettings.model_validate(raw)
    if name in current.providers:
        if not current.providers[name].enabled:
            raise ValueError(f"Harness {name!r} is disabled in configuration.")
        if current.providers[name] != provider:
            raise ValueError("Harness 配置已变化，请重新打开 Cleo 后再创建任务。")
        return
    providers = raw.setdefault("providers", {
        key: value.model_dump(mode="json") for key, value in current.providers.items()
    })
    providers[name] = provider.model_dump(mode="json")
    ProductivitySettings.model_validate(raw)
    _atomic_write(path, raw)
