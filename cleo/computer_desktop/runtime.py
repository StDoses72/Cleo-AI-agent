"""Start a named, loopback-only Docker desktop and connect both UI and model tools to it."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path

import httpx

IMAGE = "cleo-desktop:0.5.11"
LABEL = "ai.cleo.desktop"
_starting: dict[str, asyncio.Task] = {}
_ready: dict[str, dict] = {}


def identity(config: Path) -> str:
    """Purpose: Scope a desktop to a Cleo home. Input: config path. Output: safe Docker name."""
    key = os.path.normcase(str(config.resolve()))
    return "cleo-desktop-" + hashlib.sha256(key.encode()).hexdigest()[:12]


def docker(*args: str, timeout: int = 30, allow_failure=False) -> str:
    """Purpose: Run Docker without shell interpolation. Input: argv. Output: bounded result."""
    executable = shutil.which("docker")
    if not executable and os.name == "nt":
        candidates = [
            Path(os.environ.get("LOCALAPPDATA", ""))
            / "Programs/DockerDesktop/resources/bin/docker.exe",
            Path(os.environ.get("ProgramFiles", "C:/Program Files"))
            / "Docker/Docker/resources/bin/docker.exe",
        ]
        executable = next((str(path) for path in candidates if path.is_file()), None)
    if not executable:
        raise ValueError("独立桌面需要 Docker Desktop，请先安装并启动它。")
    result = subprocess.run(
        [executable, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if result.returncode and not allow_failure:
        # Never include command arguments: container creation carries a private access token.
        raise ValueError("独立桌面运行失败：" + result.stderr.strip()[-1500:])
    return result.stdout if result.returncode == 0 else ""


def inspect(config: Path) -> dict | None:
    """Purpose: Find only our container. Input: config. Output: owned metadata or missing."""
    raw = docker("container", "inspect", identity(config), allow_failure=True)
    if not raw:
        return None
    info = json.loads(raw)[0]
    if info["Config"].get("Labels", {}).get(LABEL) != identity(config):
        raise ValueError("同名容器不属于 Cleo，已停止连接。")
    return info


def engine_status() -> dict:
    """Purpose: Verify the actual desktop engine, including exit-zero connection errors.

    Input: Docker executable/context from this backend's environment.
    Output: readiness and a non-secret diagnostic; no installation or startup.
    """
    try:
        raw = docker("info", "--format", "{{json .}}", timeout=15)
        info = json.loads(raw)
        if not isinstance(info, dict):
            raise ValueError("Invalid Docker info")
        version = info.get("ServerVersion")
        if not version or info.get("ServerErrors"):
            raise ValueError("Docker engine unavailable")
        if info.get("OSType") != "linux":
            return {"ready": False, "detail": "请将 Docker Desktop 切换到 Linux containers。"}
        return {"ready": True, "version": version}
    except (ValueError, subprocess.TimeoutExpired, OSError):
        return {"ready": False, "detail": "Docker Linux 引擎尚未就绪，请启动 Docker Desktop。"}


def endpoint(info: dict) -> tuple[str, str]:
    """Purpose: Resolve a private guest endpoint. Input: Docker metadata. Output: URL and token."""
    ports = info["NetworkSettings"]["Ports"].get("8765/tcp") or []
    if len(ports) != 1 or ports[0]["HostIp"] != "127.0.0.1":
        raise ValueError("独立桌面必须仅监听本机回环地址。")
    token = next(
        (
            value.split("=", 1)[1]
            for value in info["Config"]["Env"]
            if value.startswith("CLEO_DESKTOP_TOKEN=")
        ),
        "",
    )
    if not token:
        raise ValueError("独立桌面缺少连接凭据。")
    return f"http://127.0.0.1:{int(ports[0]['HostPort'])}", token


async def request(info: dict, method: str, route: str, payload=None):
    """Purpose: Access the guest without system proxies. Input: route/body. Output: JSON."""
    url, token = endpoint(info)
    async with httpx.AsyncClient(trust_env=False, timeout=30) as client:
        response = await client.request(
            method, url + route, json=payload, headers={"Authorization": "Bearer " + token}
        )
        response.raise_for_status()
        return response.json()


def prepare(config: Path) -> dict:
    """Purpose: Build/start one owned desktop, preserving its home.
    Input: config.
    Output: metadata."""
    engine = engine_status()
    if not engine["ready"]:
        raise ValueError(engine["detail"])
    info = inspect(config)
    if info and info["State"]["Running"]:
        return info
    if not docker("image", "inspect", IMAGE, allow_failure=True):
        docker("build", "--tag", IMAGE, str(Path(__file__).parent), timeout=1200)
    name = identity(config)
    if not info:
        # Named volumes retain browser logins; no host home, Docker socket, or device is mounted.
        docker(
            "run",
            "--detach",
            "--init",
            "--hostname",
            name,
            "--name",
            name,
            "--label",
            f"{LABEL}={name}",
            "--publish",
            "127.0.0.1::8765",
            "--memory",
            "4g",
            "--cpus",
            "4",
            "--pids-limit",
            "512",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--shm-size",
            "512m",
            "--volume",
            f"{name}-home:/home/cleo",
            "--env",
            "CLEO_DESKTOP_TOKEN=" + secrets.token_urlsafe(32),
            IMAGE,
            timeout=60,
            allow_failure=True,
        )
        # Another process may have won the atomic container-name reservation.
        info = inspect(config)
        if not info:
            raise ValueError("无法创建独立桌面，请检查 Docker 的可用内存和磁盘。")
    if not info["State"]["Running"]:
        docker("start", name, timeout=60)
    return inspect(config)


async def ensure(config: Path) -> dict:
    """Purpose: Coalesce local startup and await readiness.
    Input: config.
    Output: ready metadata."""
    name = identity(config)
    if name in _ready:
        try:
            await request(_ready[name], "GET", "/status")
            return _ready[name]
        except httpx.HTTPError:
            _ready.pop(name, None)
    task = _starting.get(name)
    if task is None or task.done():
        task = _starting[name] = asyncio.create_task(asyncio.to_thread(prepare, config))
    info = await asyncio.shield(task)
    for _ in range(60):
        try:
            await request(info, "GET", "/status")
            _ready[name] = info
            return info
        except httpx.HTTPError:
            await asyncio.sleep(0.5)
    raise ValueError("独立桌面启动超时，请检查 Docker 后重试。")


async def desktop_action(config: Path, action: str = "status", text: str = "") -> dict:
    """Purpose: Serve trusted UI actions. Input: config/action. Output: connection or state."""
    if action not in {"status", "start", "take", "release", "stop", "text"}:
        raise ValueError("未知桌面操作。")
    if action == "start":
        info = await ensure(config)
    else:
        info = await asyncio.to_thread(inspect, config)
    if not info or not info["State"]["Running"]:
        task = _starting.get(identity(config))
        return {"phase": "starting" if task and not task.done() else "stopped"}
    if action == "stop":
        await asyncio.to_thread(docker, "stop", "--time", "5", identity(config))
        return {"phase": "stopped"}
    if action == "text":
        await request(info, "POST", "/text", {"text": text})
    if action in {"take", "release"}:
        state = await request(
            info, "POST", "/control", {"mode": "user" if action == "take" else "agent"}
        )
    else:
        try:
            state = await request(info, "GET", "/status")
        except httpx.HTTPError:
            return {"phase": "starting"}
    url, token = endpoint(info)
    kind = "control" if state["mode"] == "user" else "view"
    return {
        "phase": "ready",
        **state,
        "viewerUrl": url.replace("http:", "ws:") + f"/vnc/{kind}?token={token}",
    }


async def invoke(config: Path, name=None, arguments=None) -> list[dict]:
    """Purpose: Run model actions in the viewed desktop. Input: tool. Output: content blocks."""
    info = await ensure(config)
    if name is None:
        tools = await request(info, "GET", "/tools")
        return [{"type": "text", "text": json.dumps(tools, ensure_ascii=False)}]
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        try:
            return await request(
                info, "POST", "/action", {"name": name, "arguments": arguments or {}}
            )
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 409:
                raise ValueError(exc.response.text[:500]) from exc
            # No snapshot or model action happens during manual login; cancellation ends this wait.
            await asyncio.sleep(0.5)
    raise ValueError("用户仍在接管桌面。交回控制后可继续任务。")
