"""Time Cleo's start and send paths against the real desktop backend (#183, ADR 0015).

Drives ``python -m cleo.desktop.server`` over its JSON-lines protocol, as Electron does, with a
fresh home, and prints one JSON line of seconds:

  cold.*      spawn -> load_workspace result, -> get_runtime_catalog result (the first screen)
  new.*       create_thread; then two turns (first event, first answer, done)
  resume.*    a fresh backend on the same home: load_workspace, then a turn on the same task
  prepared.*  (BENCH_PREPARE=1) another restart: prepare_thread, 10 s of "writing", then a turn

Usage (from any directory; the backend runs from <backend_root> with this interpreter):
  python scripts/bench_desktop_latency.py <backend_root> <home> <workdir> <codex|claude> [model]

Real harness turns are sent ("Reply with the single word OK."), so the harness must be signed in.
BENCH_TRACE=<wrapper.py> runs the backend through a wrapper script (e.g. one that logs timings to
stderr) and BENCH_TRACE_LOG=<file> collects its stderr with markers between steps.
"""
import json
import os
import subprocess
import sys
import threading
import time
import uuid

ROOT, HOME, WORK, PROVIDER = sys.argv[1:5]
MODEL = sys.argv[5] if len(sys.argv) > 5 else None


def prepare_home():
    os.makedirs(HOME, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)
    config = os.path.join(HOME, "cleo.json")
    if not os.path.exists(config):
        with open(config, "w", encoding="utf-8") as handle:
            json.dump({"active_profiles": {"agent": "default"}, "profiles": {
                "agents": {"default": {"provider": "openai", "model": "test", "api_key": "test"}},
                "directories": {"default": {"root_dir": WORK}}}}, handle)
        with open(os.path.join(HOME, "harnesses.json"), "w", encoding="utf-8") as handle:
            json.dump({"default_provider": "codex", "providers": {
                "codex": {"type": "codex_sdk", "model": "gpt-5.6-luna",
                          "options": {"approval_mode": "deny_all", "sandbox": "read-only"}},
                "claude": {"type": "claude_sdk"}}}, handle)


class Backend:
    def __init__(self):
        env = {**os.environ, "CLEO_HOME": HOME, "CLEO_CONFIG_PATH": os.path.join(HOME, "cleo.json"),
               "CLEO_HARNESSES_CONFIG_PATH": os.path.join(HOME, "harnesses.json"),
               "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        self.started = time.perf_counter()
        self.process = subprocess.Popen(
            [sys.executable, *([os.environ["BENCH_TRACE"]] if os.environ.get("BENCH_TRACE")
                               else ["-m", "cleo.desktop.server"])], cwd=ROOT, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=open(os.environ["BENCH_TRACE_LOG"], "a", encoding="utf-8")
            if os.environ.get("BENCH_TRACE") else subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1)
        self.waiters = {}
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            waiter = self.waiters.get(message.get("id"))
            if waiter is not None:
                waiter(message, time.perf_counter())

    def request(self, method, params=None, timeout=300):
        request_id = str(uuid.uuid4())
        done = threading.Event()
        record = {"events": [], "result": None}

        def on_message(message, now):
            if message["type"] == "event":
                record["events"].append((now, message["event"]))
            else:
                record["result"] = message
                record["at"] = now
                done.set()

        self.waiters[request_id] = on_message
        sent = time.perf_counter()
        self.process.stdin.write(json.dumps({"id": request_id, "method": method,
                                             "params": params or {}}) + "\n")
        self.process.stdin.flush()
        if not done.wait(timeout):
            raise TimeoutError(method)
        record["sent"] = sent
        if record["result"]["type"] == "error":
            raise RuntimeError(f"{method}: {record['result']['error']}")
        return record

    def close(self):
        try:
            self.request("shutdown", timeout=60)
        except Exception:
            pass
        try:
            self.process.wait(30)
        except subprocess.TimeoutExpired:
            self.process.kill()


def mark(label):
    if os.environ.get("BENCH_TRACE_LOG"):
        with open(os.environ["BENCH_TRACE_LOG"], "a", encoding="utf-8") as handle:
            handle.write("---- " + label + chr(10))


def turn(backend, thread_id, label, prompt="Reply with the single word OK."):
    mark(label)
    record = backend.request("stream_turn", {"thread_id": thread_id, "prompt": prompt,
                                             "attachments": []}, timeout=600)
    sent = record["sent"]
    first = record["events"][0][0] - sent if record["events"] else None
    answer = next((now - sent for now, event in record["events"]
                   if "assistant" in json.dumps(event) and "OK" in json.dumps(event)), None)
    return {f"{label}.first_event": first, f"{label}.first_answer": answer,
            f"{label}.done": record["at"] - sent}


def main():
    prepare_home()
    results = {}
    backend = Backend()
    load = backend.request("load_workspace", timeout=300)
    results["cold.load_workspace"] = load["at"] - backend.started
    catalog = backend.request("get_runtime_catalog", timeout=300)
    results["cold.runtime_catalog"] = catalog["at"] - backend.started
    mark("create_thread")
    created = backend.request("create_thread", {
        "space": "productivity", "project_id_value": "productivity:workspace",
        "project_path": WORK, "provider": PROVIDER, **({"model": MODEL} if MODEL else {}),
    }, timeout=300)
    results["new.create_thread"] = created["at"] - created["sent"]
    thread_id = created["result"]["result"]["id"]
    results.update(turn(backend, thread_id, "new.turn1"))
    results.update(turn(backend, thread_id, "new.turn2"))
    backend.close()
    backend = Backend()
    load = backend.request("load_workspace", timeout=300)
    results["resume.load_workspace"] = load["at"] - backend.started
    results.update(turn(backend, thread_id, "resume.turn1"))
    backend.close()
    if os.environ.get("BENCH_PREPARE"):
        # Restart again; the user starts writing (prepare_thread) and sends 10 s later.
        backend = Backend()
        backend.request("load_workspace", timeout=300)
        backend.request("prepare_thread", {"thread_id": thread_id}, timeout=60)
        time.sleep(10)
        results.update(turn(backend, thread_id, "prepared.turn1"))
        backend.close()
    print(json.dumps({key: round(value, 2) if value is not None else None
                      for key, value in results.items()}))


main()
