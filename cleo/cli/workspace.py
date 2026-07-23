"""Explicit workspace reset operation exposed by the CLI."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

LOCAL_CONFIG_PATH = "config/cleo.json"
LOCAL_HARNESSES_CONFIG_PATH = "config/harnesses.json"


def _run_git(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", "-C", str(repo_root), *args],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        details = result.stderr.strip() or result.stdout.strip() or "no output"
        command = "git " + " ".join(args)
        raise RuntimeError(f"{command} failed: {details}")
    return result


def _validated_preserve_paths(
    repo_root: Path,
    preserve_paths: tuple[str, ...],
) -> list[tuple[str, Path]]:
    validated: list[tuple[str, Path]] = []
    for rel in preserve_paths:
        rel_path = Path(rel)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            raise RuntimeError(f"Refusing invalid preserve path: {rel}")

        absolute = (repo_root / rel_path).resolve()
        if not absolute.is_relative_to(repo_root):
            raise RuntimeError(f"Refusing preserve path outside repository: {rel}")

        validated.append((rel_path.as_posix(), absolute))
    return validated


def _copy_path(src: Path, dst: Path) -> None:
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
        return
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def _git_clean_args(preserved: list[tuple[str, Path]]) -> list[str]:
    args = ["clean", "-ffdx"]
    for rel, _ in preserved:
        args.extend(["-e", rel])
    return args


def reset_workspace_to_main(
    repo_root: Path,
    *,
    main_branch: str = "main",
    preserve_paths: tuple[str, ...] = (
        LOCAL_CONFIG_PATH,
        LOCAL_HARNESSES_CONFIG_PATH,
    ),
) -> None:
    repo_root = repo_root.resolve()

    git_root = Path(_run_git(repo_root, "rev-parse", "--show-toplevel").stdout.strip()).resolve()
    if git_root != repo_root:
        raise RuntimeError(f"Refusing to reset unexpected repository root: {git_root}")

    try:
        _run_git(repo_root, "rev-parse", "--verify", "--quiet", f"refs/heads/{main_branch}")
    except RuntimeError as exc:
        raise RuntimeError(f"Local branch '{main_branch}' does not exist.") from exc

    preserved = _validated_preserve_paths(repo_root, preserve_paths)
    clean_args = _git_clean_args(preserved)

    with tempfile.TemporaryDirectory(prefix="cleo-reset-") as tmp_dir:
        backup_root = Path(tmp_dir)
        for rel, absolute in preserved:
            if absolute.exists():
                _copy_path(absolute, backup_root / rel)

        _run_git(repo_root, "reset", "--hard")
        _run_git(repo_root, *clean_args)
        _run_git(repo_root, "switch", main_branch)
        _run_git(repo_root, "reset", "--hard", main_branch)
        _run_git(repo_root, *clean_args)

        for rel, absolute in preserved:
            backup = backup_root / rel
            if backup.exists():
                _copy_path(backup, absolute)

    print(f"Reset workspace to local '{main_branch}' branch.")
    if preserved:
        preserved_list = ", ".join(rel for rel, _ in preserved)
        print(f"Preserved local file(s): {preserved_list}")
