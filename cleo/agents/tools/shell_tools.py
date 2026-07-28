"""本地 shell 执行工具: 带审计、沙箱与 allowlist 策略的命令执行。

核心入口 `run_shell_command` 注册于 cleo/agents/cleo.py 的
Agent.toolist, 由 deepagents 框架按前台 LLM 的 tool call 调用。
"""

import json
import os
import shlex
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from langchain_core.tools import tool

from cleo.config.settings import settings

VIRTUAL_WORKSPACE_PREFIX = "/workspace"
VIRTUAL_PROJECT_PREFIXES = {
    "/config": "config",
    "/core": "core",
    "/scripts": "scripts",
    "/skills": "skills",
    "/tools": "tools",
}


def _append_shell_audit(record: dict) -> None:
    """追加一条 shell 审计记录到 JSONL 日志, 失败静默忽略。

    被 `_blocked_shell_result` 与 `run_shell_command` 调用。

    Args:
        record: 审计字段 dict (timestamp/command/allowed/reason 等);
            由调用方构造。

    Returns:
        None; 审计日志供人工排查, 代码内无消费方。
    """
    try:
        settings.SHELL_AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(settings.SHELL_AUDIT_LOG_PATH, "a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        # Audit logging should never crash the tool call.
        pass


def _split_command(command: str) -> list[str]:
    """把命令字符串拆分为参数列表 (posix=False 保留引号) 并剥离成对引号。

    被 `_translate_command_args` 调用 (间接服务于策略检查)。

    Args:
        command: 原始命令字符串; 来自 `run_shell_command` 的入参。

    Returns:
        参数 token 列表, 供路径翻译与主命令提取使用。
    """
    return [_strip_matching_quotes(part) for part in shlex.split(command, posix=False)]


def _strip_matching_quotes(value: str) -> str:
    """剥离字符串两端成对的单/双引号。

    被 `_split_command`、`_resolve_cwd`、`_normalized_command_names`
    等本文件内部函数调用。

    Args:
        value: 待处理 token; 来自命令拆分结果或配置项。

    Returns:
        去引号后的 str, 供路径比较与命令名归一化使用。
    """
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _translate_virtual_path(value: str) -> str:
    """Translate one complete virtual path argument into a project-local path.

    中文说明: 将 Deep Agents 虚拟路径 (如 /workspace、/skills) 翻译为
    SHELL_SANDBOX_ROOT 下的真实本地路径; 非虚拟路径原样返回。
    被 `_translate_command_args` 与 `_resolve_cwd` 调用。

    Args:
        value: 单个路径参数; 来自命令 token 或 working_directory。

    Returns:
        翻译后的本地路径 str (或原值), 供 subprocess 与沙箱检查使用。
    """
    if not value:
        return value

    normalized = value.replace("\\", "/")
    mappings: list[tuple[str, Path]] = [
        (VIRTUAL_WORKSPACE_PREFIX, settings.SHELL_SANDBOX_ROOT),
        *(
            (virtual_prefix, settings.SHELL_SANDBOX_ROOT / real_child)
            for virtual_prefix, real_child in VIRTUAL_PROJECT_PREFIXES.items()
        ),
    ]
    for virtual_prefix, real_base in mappings:
        if normalized == virtual_prefix:
            return str(real_base)
        if normalized.startswith(f"{virtual_prefix}/"):
            suffix = normalized[len(virtual_prefix) + 1 :]
            return str(real_base / Path(*suffix.split("/")))
    return value


def _translate_virtual_paths_in_command(command: str) -> str:
    """对整条命令字符串做虚拟路径替换 (子串级, 长前缀优先)。

    仅被 `run_shell_command` 调用, 处理引号内或拼接形式的虚拟路径。

    Args:
        command: 原始命令字符串; 来自 tool 入参。

    Returns:
        替换后的命令 str, 供策略检查与 subprocess 执行。
    """
    translated = command
    mappings: list[tuple[str, Path]] = [
        (VIRTUAL_WORKSPACE_PREFIX, settings.SHELL_SANDBOX_ROOT),
        *(
            (virtual_prefix, settings.SHELL_SANDBOX_ROOT / real_child)
            for virtual_prefix, real_child in VIRTUAL_PROJECT_PREFIXES.items()
        ),
    ]
    for virtual_prefix, real_base in sorted(mappings, key=lambda item: len(item[0]), reverse=True):
        translated = translated.replace(virtual_prefix, str(real_base))
    return translated


def _translate_command_args(command: str) -> list[str]:
    """拆分命令并对每个 token 做虚拟路径翻译。

    被 `_extract_primary_command` 与 `_first_outside_sandbox_path` 调用。

    Args:
        command: 原始命令字符串; 来自 `run_shell_command`。

    Returns:
        翻译后的参数列表, 供主命令提取与沙箱边界检查。
    """
    return [_translate_virtual_path(part) for part in _split_command(command)]


def _extract_primary_command(command: str) -> str:
    """提取命令的主程序名 (首个 token 的 basename)。

    仅被 `run_shell_command` 调用, 用于 allowlist 匹配与审计记录;
    拆分失败时回退到简单的空格切分。

    Args:
        command: 已做虚拟路径翻译的命令字符串。

    Returns:
        主命令名 str (可能为空), 用于 allowlist 检查。
    """
    try:
        parts = _translate_command_args(command)
        if not parts:
            return ""
        return Path(parts[0].strip().strip('"').strip("'")).name
    except Exception:
        return Path((command or "").strip().split(" ")[0].strip().strip('"').strip("'")).name


def _resolve_cwd(working_directory: str) -> Path:
    """解析工作目录: 空值回退到 SHELL_SANDBOX_ROOT, 相对路径基于 sandbox。

    仅被 `run_shell_command` 调用。

    Args:
        working_directory: tool 入参 (LLM 传入), 可为空或含虚拟路径。

    Returns:
        解析后的绝对 Path, 供沙箱检查与 subprocess 的 cwd 使用。
    """
    working_directory = _translate_virtual_path(_strip_matching_quotes(working_directory))
    if not working_directory:
        return settings.SHELL_SANDBOX_ROOT

    candidate = Path(working_directory)
    if not candidate.is_absolute():
        candidate = settings.SHELL_SANDBOX_ROOT / candidate
    return candidate.resolve()


def _truncate_output(text: str) -> str:
    """按 SHELL_MAX_OUTPUT_CHARS 截断超长输出并标注省略字符数。

    仅被 `run_shell_command` 调用, 分别处理 stdout 与 stderr。

    Args:
        text: subprocess 捕获的原始输出。

    Returns:
        截断后的 str, 嵌入返回给 LLM 的结果文本。
    """
    max_chars = settings.SHELL_MAX_OUTPUT_CHARS
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    omitted = len(text) - max_chars
    return f"{text[:max_chars]}\n\n...[truncated {omitted} chars]"


def _path_is_inside(child: Path, parent: Path) -> bool:
    """判断 child 路径是否位于 parent 目录之内 (跨平台 normcase 比较)。

    被 `run_shell_command` 与 `_first_outside_sandbox_path` 调用,
    用于沙箱边界检查。

    Args:
        child: 待检查路径 (cwd 或命令中的绝对路径参数)。
        parent: 沙箱根 SHELL_SANDBOX_ROOT。

    Returns:
        bool; False 时调用方将阻断命令执行。
    """
    try:
        child_resolved = child.resolve()
        parent_resolved = parent.resolve()
        common = os.path.commonpath([str(child_resolved), str(parent_resolved)])
    except (OSError, ValueError):
        return False
    return os.path.normcase(common) == os.path.normcase(str(parent_resolved))


def _normalized_command_names(commands: list[str]) -> set[str]:
    """把配置的命令列表归一化为 basename + casefold 的集合。

    仅被 `run_shell_command` 调用, 处理 SHELL_ALLOWED_COMMANDS。

    Args:
        commands: settings 中的 allowlist 命令字符串列表。

    Returns:
        归一化命令名集合, 用于与主命令名做大小写不敏感匹配。
    """
    names: set[str] = set()
    for command in commands:
        stripped = _strip_matching_quotes(command.strip())
        if stripped:
            names.add(Path(stripped).name.casefold())
    return names


def _first_denied_pattern(command: str) -> str | None:
    """返回命令中命中的第一个拒绝模式 (子串、大小写不敏感)。

    仅被 `run_shell_command` 调用, 检查 SHELL_DENIED_PATTERNS。

    Args:
        command: 已翻译的命令字符串。

    Returns:
        命中的 pattern str 或 None; 命中时调用方阻断执行。
    """
    command_text = command.casefold()
    for pattern in settings.SHELL_DENIED_PATTERNS:
        if pattern and pattern.casefold() in command_text:
            return pattern
    return None


def _first_outside_sandbox_path(command: str, sandbox_root: Path) -> str | None:
    """找出命令中第一个越过沙箱边界的绝对路径参数 (best-effort)。

    仅被 `run_shell_command` 在 SHELL_ENFORCE_SANDBOX 开启时调用。

    Args:
        command: 已翻译的命令字符串。
        sandbox_root: 沙箱根 SHELL_SANDBOX_ROOT。

    Returns:
        越界路径 str 或 None; 非 None 时调用方阻断执行。
    """
    for arg in _translate_command_args(command)[1:]:
        candidate = Path(_strip_matching_quotes(arg))
        if candidate.is_absolute() and not _path_is_inside(candidate, sandbox_root):
            return str(candidate)
    return None


def _blocked_shell_result(audit: dict, start: float, reason: str) -> str:
    """记录一条"被策略阻断"的审计并返回统一的错误文本。

    仅被 `run_shell_command` 在各策略检查失败分支调用。

    Args:
        audit: 调用方构造的审计 dict, 本函数补写 allowed/reason/duration。
        start: `time.perf_counter()` 的起始时间戳, 来自调用方。
        reason: 阻断原因, 写入审计并返回给 LLM。

    Returns:
        "Command blocked by shell policy: ..." str; 由 `run_shell_command`
        返回, 经 langchain 框架回传给 LLM。
    """
    audit["allowed"] = False
    audit["reason"] = reason
    audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
    _append_shell_audit(audit)
    return f"Command blocked by shell policy: {reason}"


@tool
def run_shell_command(command: str, working_directory: str = "") -> str:
    """
    Run a local shell command for the user.

    The tool reads its shell policy from the active shell profile. It can enforce
    an allowlist, configured denied patterns, a best-effort sandbox boundary, and
    a fail-closed approval requirement. It always records audit entries, applies
    the configured timeout, truncates oversized output, and starts in the
    configured project root when no working directory is provided.

    Args:
        command: Command string to execute. `/workspace/...`, `/skills/...`,
            and other known Deep Agents virtual paths are translated to matching
            local project paths before execution.
        working_directory: Optional working directory. Relative paths resolve
            under the configured project root.

    Returns:
        A text summary containing stdout or stderr.

    中文说明: 执行本地 shell 命令 (Windows 走 powershell, 其他平台走
    shell=True), 全流程带审计日志与策略检查。注册于 cleo/agents/cleo.py
    的 Agent.toolist, 由 deepagents 框架按前台 LLM 的 tool call 调用。

    参数来源:
        command/working_directory 均由前台 Agent 的 LLM 在 tool call 中
        生成 (非用户直接传入); 策略阈值来自 settings 的 shell profile。

    返回值消费: 结果文本 (成功/退出码/超时/被阻断) 由 langchain 框架
    序列化为 tool message 回传给 LLM, 供其继续推理或组织最终回复。
    """
    start = time.perf_counter()
    now = datetime.now(UTC).isoformat()

    if not command or not command.strip():
        return "Error: command cannot be empty."

    translated_command = _translate_virtual_paths_in_command(command)
    sandbox_root = settings.SHELL_SANDBOX_ROOT
    cwd = _resolve_cwd(working_directory)
    primary = _extract_primary_command(translated_command)

    audit = {
        "timestamp_utc": now,
        "command": translated_command,
        "primary_command": primary,
        "working_directory": str(cwd),
        "sandbox_root": str(sandbox_root),
        "allowed": False,
        "reason": "",
        "returncode": None,
        "duration_ms": None,
    }

    if settings.SHELL_REQUIRE_APPROVAL:
        return _blocked_shell_result(
            audit,
            start,
            "approval is required, but no interactive approval flow is available",
        )

    denied_pattern = _first_denied_pattern(translated_command)
    if denied_pattern is not None:
        return _blocked_shell_result(
            audit,
            start,
            f"command matched denied pattern: {denied_pattern}",
        )

    if settings.SHELL_REQUIRE_ALLOWLIST:
        allowed_commands = _normalized_command_names(settings.SHELL_ALLOWED_COMMANDS)
        if primary.casefold() not in allowed_commands:
            return _blocked_shell_result(
                audit,
                start,
                f"primary command is not in allowlist: {primary or '<empty>'}",
            )

    if settings.SHELL_ENFORCE_SANDBOX:
        if not _path_is_inside(cwd, sandbox_root):
            return _blocked_shell_result(
                audit,
                start,
                f"working directory is outside sandbox: {cwd}",
            )
        outside_path = _first_outside_sandbox_path(translated_command, sandbox_root)
        if outside_path is not None:
            return _blocked_shell_result(
                audit,
                start,
                f"absolute path argument is outside sandbox: {outside_path}",
            )

    try:
        env = os.environ.copy()
        env.setdefault("PYTHONUTF8", "1")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        if os.name == "nt":
            run_args: str | list[str] = [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                translated_command,
            ]
            use_shell = False
        else:
            run_args = translated_command
            use_shell = True

        result = subprocess.run(
            run_args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=settings.SHELL_TIMEOUT_SECONDS,
            shell=use_shell,
            env=env,
        )

        audit["allowed"] = True
        audit["returncode"] = result.returncode
        audit["reason"] = "executed"
        audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
        _append_shell_audit(audit)

        stdout = _truncate_output(result.stdout or "")
        stderr = _truncate_output(result.stderr or "")

        if result.returncode == 0:
            return f"Command executed successfully.\n\nstdout:\n{stdout}"
        return (
            f"Command exited with code {result.returncode}.\n\n"
            f"stdout:\n{stdout}\n\nstderr:\n{stderr}"
        )
    except subprocess.TimeoutExpired:
        audit["reason"] = f"timeout after {settings.SHELL_TIMEOUT_SECONDS}s"
        audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
        _append_shell_audit(audit)
        return f"Error: command timed out after {settings.SHELL_TIMEOUT_SECONDS} seconds."
    except Exception as exc:
        audit["reason"] = f"execution exception: {str(exc)}"
        audit["duration_ms"] = round((time.perf_counter() - start) * 1000, 2)
        _append_shell_audit(audit)
        return f"Error happens in running the command: {str(exc)}"
