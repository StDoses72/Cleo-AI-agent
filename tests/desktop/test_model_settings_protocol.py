"""Exercise the desktop JSONL interface against an isolated, real configuration."""

import json
import os
import subprocess
import sys
from queue import Queue
from threading import Thread


def test_model_connection_lifecycle_over_desktop_protocol(tmp_path):
    config = tmp_path / "cleo.json"
    harness = tmp_path / "harnesses.json"
    config.write_text(
        json.dumps(
            {
                "active_profiles": {"agent": "original"},
                "profiles": {
                    "agents": {
                        "original": {
                            "provider": "openai",
                            "model": "original-model",
                            "api_key": "test-original",
                        }
                    },
                    "directories": {"default": {"root_dir": str(tmp_path)}},
                },
            }
        ),
        encoding="utf-8",
    )
    harness.write_text(
        '{"default_provider":"codex","providers":{"codex":{"type":"codex_sdk"}}}', encoding="utf-8"
    )
    process = subprocess.Popen(
        [sys.executable, "-u", "-m", "cleo.desktop.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        env={
            **os.environ,
            "CLEO_HOME": str(tmp_path),
            "CLEO_CONFIG_PATH": str(config),
            "CLEO_HARNESSES_CONFIG_PATH": str(harness),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
        },
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    responses: Queue = Queue()

    def read():
        try:
            for line in process.stdout:
                responses.put(json.loads(line))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            responses.put(exc)
        responses.put(EOFError("Desktop protocol process closed"))

    reader = Thread(target=read, daemon=True)
    reader.start()
    sequence = 0

    def request(method, **params):
        nonlocal sequence
        sequence += 1
        process.stdin.write(
            json.dumps({"id": str(sequence), "method": method, "params": params}) + "\n"
        )
        process.stdin.flush()
        result = responses.get(timeout=30)
        if isinstance(result, Exception):
            raise result
        assert result["id"] == str(sequence)
        assert "test-added-key" not in json.dumps(result)
        return result

    try:
        result = request(
            "create_model_connection",
            connection={
                "displayName": "测试连接",
                "provider": "openai",
                "apiKey": "test-added-key",
                "models": ["model-a", "model-b"],
            },
        )["result"]
        assert result["activeAgent"] == "original"
        added = next(p for p in result["profiles"] if p["displayName"] == "测试连接")
        identifier = added["name"]
        assert added["models"] == ["model-a", "model-b"]
        request("select_chat_model", profile_id=identifier, model="model-b")
        request("save_dream_settings", selection=identifier, model="model-a")
        result = request("get_model_settings")["result"]
        assert result["activeDreamModel"] == "model-a"
        assert next(p for p in result["profiles"] if p["name"] == identifier)["model"] == "model-b"
        result = request("rename_model_connection", profile_id=identifier, label="新的显示名称")[
            "result"
        ]
        assert (
            next(p for p in result["profiles"] if p["name"] == identifier)["displayName"]
            == "新的显示名称"
        )
        assert request("remove_model_connection", profile_id=identifier)["type"] == "error"
        request("select_chat_model", profile_id="original", model="original-model")
        request("save_dream_settings", selection="mode:follow")
        result = request("remove_model_connection", profile_id=identifier)["result"]
        assert [p["name"] for p in result["profiles"]] == ["original"]
        assert "test-added-key" not in config.read_text(encoding="utf-8")
        request("shutdown")
        process.wait(timeout=10)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        process.stdin.close()
        reader.join(timeout=5)
        process.stdout.close()
