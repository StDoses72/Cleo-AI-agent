"""Dependency-free smoke check; run with the bundled Cleo Python runtime."""
import asyncio
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from cleo.desktop.service import PRODUCTIVITY_COMMANDS, DesktopService
from cleo.desktop.skills import discover_skills


def main():
    """Check real skill loading and desktop routing using temporary files only."""
    with tempfile.TemporaryDirectory(prefix="cleo-skills-") as temporary:
        root = Path(temporary)
        home = root / "home"
        project = root / "project"
        (project / ".git").mkdir(parents=True)
        for harness in ("codex", "claude"):
            for name in ("eli5", "help"):
                # Same fixed directory the harness process uses: <CLEO_HOME>/data/<harness>.
                path = root / "cleo" / "data" / harness / "skills" / name / "SKILL.md"
                path.parent.mkdir(parents=True)
                path.write_text(
                    f"---\nname: {name}\n---\n{harness} actual instructions", encoding="utf-8"
                )
        with patch.object(Path, "home", return_value=home), patch(
            "cleo.config.settings.APP_HOME", root / "cleo",
        ), patch.dict(os.environ, {
            # External vendor homes must not feed the catalog.
            "CODEX_HOME": str(home / ".codex"), "CLAUDE_CONFIG_DIR": str(home / ".claude"),
        }):
            manifest = {
                "id": "test", "space": "productivity", "project": "workspace", "cwd": str(project),
                "provider": "codex",
            }
            service = DesktopService.__new__(DesktopService)
            service.store = SimpleNamespace(
                load_manifest=lambda _: manifest,
                update_manifest=lambda _, **changes: manifest.update(changes),
            )
            service.settings = SimpleNamespace(
                MEMORY_DIR=root / "memory",
                productivity=SimpleNamespace(default_provider="codex"),
            )
            service._activate = lambda _: None
            service._is_evolution = lambda _: False
            service._productivity_provider = lambda name: SimpleNamespace(type=f"{name}_sdk")
            service._run_tasks = {}
            service._steering_runs = {}
            service._runtime_locks = {}
            service._run_ids = {}
            service._pending_approvals = {}
            service._run_workspaces = {}
            service._workspace_guard = asyncio.Lock()
            service._stream_productivity = AsyncMock()
            service._run_command = AsyncMock()
            emit = AsyncMock()
            async def send(prompt):
                await service.stream_turn(
                    thread_id="test", prompt=prompt, attachments=[], emit=emit
                )
            for harness in ("codex", "claude", "codex"):
                manifest["provider"] = harness
                catalog = service._local_skills(manifest)
                assert len(catalog) == 2
                assert all(s.source.startswith(harness) for s in catalog)
                for request in ("/eli5", "/eli5 explain recursion\nsecond line"):
                    asyncio.run(send(request))
                    forwarded = service._stream_productivity.call_args.args[1]
                    assert request in forwarded
                    assert f"{harness} actual instructions" in forwarded
                    assert "SKILL.md:" in forwarded
            asyncio.run(send("/help"))
            service._run_command.assert_awaited_once_with(manifest, "/help", emit)
            help_skill = next(s for s in catalog if s.name == "help")
            assert help_skill.command.startswith("/skill:help:")
            asyncio.run(send(help_skill.command))
            assert "codex actual instructions" in service._stream_productivity.call_args.args[1]
            duplicate = project / ".codex" / "skills" / "eli5" / "SKILL.md"
            duplicate.parent.mkdir(parents=True)
            duplicate.write_text("Project specific instructions")
            catalog = service._local_skills(manifest)
            assert len({s.command for s in catalog}) == 3
            assert all(s.command != "/eli5" for s in catalog)
            local = next(s for s in catalog if s.path == duplicate)
            assert "Project specific instructions" in local.expand(local.command)
            duplicate.unlink()
            try:
                local.expand(local.command)
            except ValueError:
                pass
            else:
                raise AssertionError("Deleted skill must fail explicitly")
            assert discover_skills("other", str(project), PRODUCTIVITY_COMMANDS) == []
            manifest["space"] = "non_productivity"
            assert service._local_skills(manifest) == []
    print(
        "PASS: discovery, harness switching, both invocation forms, instruction loading, "
        "conflicts, builtins, unavailable files and unsupported scopes"
    )


if __name__ == "__main__":
    main()
