"""Filesystem and Git workspace operations shared by application entry points."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

LOCAL_CONFIG_PATH = "config/cleo.json"
LOCAL_HARNESSES_CONFIG_PATH = "config/harnesses.json"


def _run_git(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """执行一条 git 子命令并在失败时抛出 RuntimeError。

    参数:
        repo_root: 仓库根目录, 由 reset_workspace_to_main 解析后传入(绝对路径)。
        args: git 子命令及参数, 由各调用点(clean/reset/switch 等)拼接传入。

    返回:
        subprocess.CompletedProcess[str]: 成功后的进程结果(含 stdout),
        仅被 reset_workspace_to_main 用于读取 `rev-parse --show-toplevel` 的输出;
        其余调用点忽略返回值, 仅依赖副作用。
    """
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
    """校验 preserve_paths 均为仓库内的相对路径, 防止 path traversal。

    参数:
        repo_root: 已 resolve 的仓库根目录, 由 reset_workspace_to_main 传入。
        preserve_paths: 待保留的相对路径元组, 来自 reset_workspace_to_main 的
            preserve_paths 参数(默认 LOCAL_CONFIG_PATH / LOCAL_HARNESSES_CONFIG_PATH)。

    返回:
        list[tuple[str, Path]]: (POSIX 风格相对路径, 绝对路径) 列表,
        由 reset_workspace_to_main 消费, 用于备份/恢复以及构造 git clean 的
        -e exclude 参数(经 _git_clean_args)。
    """
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
    """把单个文件或目录拷贝到目标位置(目录用 copytree 合并)。

    参数:
        src: 源路径, 来自 reset_workspace_to_main 中的 preserve 文件绝对路径
            或其临时备份路径。
        dst: 目标路径, 由 reset_workspace_to_main 构造(临时备份目录内或仓库内原位置)。

    返回:
        None; 副作用为文件系统拷贝, 结果由 reset_workspace_to_main 在
        备份/恢复两个阶段直接使用。
    """
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
        return
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def _git_clean_args(preserved: list[tuple[str, Path]]) -> list[str]:
    """构造带 -e exclude 的 `git clean -ffdx` 参数列表, 保护 preserve 文件不被清理。

    参数:
        preserved: (相对路径, 绝对路径) 列表, 来自 _validated_preserve_paths 的返回值。

    返回:
        list[str]: git clean 参数列表, 由 reset_workspace_to_main 解包后传给 _run_git。
    """
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
    """把工作区硬重置到本地 main 分支, 同时备份并恢复 preserve 的本地配置文件。

    流程: 校验仓库根与 main 分支存在 -> 备份 preserve 文件到临时目录 ->
    `git reset --hard` + `git clean -ffdx`(带 -e exclude) -> 切回 main 并再次
    重置清理 -> 恢复 preserve 文件。

    参数:
        repo_root: 仓库根目录, 由 cleo/cli/application.py:155 传入 SOURCE_ROOT。
        main_branch: 目标分支名, 目前调用方使用默认值 "main"。
        preserve_paths: 需在重置中保留的仓库内相对路径, 目前调用方使用默认值
            (config/cleo.json 与 config/harnesses.json)。

    返回:
        None; 通过 print 向终端输出重置结果与保留文件清单(直接由 CLI 用户阅读)。
        校验失败时抛出 RuntimeError, 由 application.py 的异常处理兜底。
    """
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


def resolve_productivity_cwd(argument: str, current_cwd: str) -> str:
    """Resolve a /cd argument to an existing absolute directory."""
    if not argument:
        raise ValueError("Usage: /cd <directory>")
    expanded = Path(os.path.expandvars(argument)).expanduser()
    path = expanded if expanded.is_absolute() else Path(current_cwd) / expanded
    path = path.resolve()
    if not path.is_dir():
        raise ValueError(f"Directory does not exist: {path}")
    return os.path.normcase(str(path))
