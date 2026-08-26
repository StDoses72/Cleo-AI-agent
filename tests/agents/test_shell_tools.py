from types import SimpleNamespace

import cleo.agents.tools.shell_tools as shell_tools


def _bind_sandbox(monkeypatch, sandbox_root) -> str:
    """Bind the shell path helpers to an isolated sandbox and return its text path."""
    monkeypatch.setattr(
        shell_tools,
        "settings",
        SimpleNamespace(SHELL_SANDBOX_ROOT=sandbox_root),
    )
    return str(sandbox_root)


def test_virtual_path_translation_preserves_nested_shell_syntax(tmp_path, monkeypatch) -> None:
    root = _bind_sandbox(monkeypatch, tmp_path / "sandbox")
    cases = {
        "Get-Content /workspace/a.txt": f"Get-Content {root}/a.txt",
        'echo "/workspace/a b.txt"': f'echo "{root}/a b.txt"',
        'powershell -Command "Get-Content /workspace/a.txt"': (
            f'powershell -Command "Get-Content {root}/a.txt"'
        ),
        'python -c "open(\'/workspace/a.txt\').read()"': (
            f'python -c "open(\'{root}/a.txt\').read()"'
        ),
        "tool --file=/workspace/a.txt": f"tool --file={root}/a.txt",
        "Get-Content /skills/demo/SKILL.md": (
            f"Get-Content {tmp_path / 'sandbox' / 'skills'}/demo/SKILL.md"
        ),
    }

    for command, expected in cases.items():
        assert shell_tools._translate_virtual_paths_in_command(command) == expected


def test_virtual_path_translation_ignores_embedded_prefixes(tmp_path, monkeypatch) -> None:
    _bind_sandbox(monkeypatch, tmp_path / "sandbox")
    command = (
        "echo https://example.com/workspace/a "
        "C:/workspace/a /tmp/workspace/a /workspace_old /toolshed"
    )

    assert shell_tools._translate_virtual_paths_in_command(command) == command


def test_virtual_path_translation_preserves_original_spacing(tmp_path, monkeypatch) -> None:
    root = _bind_sandbox(monkeypatch, tmp_path / "sandbox")
    command = "Get-Content   '/workspace/a.txt'  |  Select-String foo"

    assert shell_tools._translate_virtual_paths_in_command(command) == (
        f"Get-Content   '{root}/a.txt'  |  Select-String foo"
    )


def test_project_bound_shell_paths_resolve_from_selected_project(tmp_path) -> None:
    project_root = (tmp_path / "selected-project").resolve()
    project_root.mkdir()

    assert shell_tools._resolve_cwd("", project_root) == project_root
    assert shell_tools._resolve_cwd("src", project_root) == project_root / "src"
    assert shell_tools._translate_virtual_paths_in_command(
        "Get-Content /workspace/README.md", project_root
    ) == f"Get-Content {project_root}/README.md"
