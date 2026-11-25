"""Time opening a stored conversation from the sidebar (#201).

Builds a home with a short and a long conversation, then measures, in seconds:

  open.*    ``load_thread`` against the real backend (``python -m cleo.desktop.server`` over its
            JSON-lines protocol, as Electron calls it), for each conversation with its history
            index ready and with the index missing, the first time after the backend starts and
            again when switching back (the median of three).
  page.*    ``load_timeline`` for the newest page and for the page before it, on the open task.
  usage.*   ``load_task_usage``, which the window asks for once the conversation is on screen
            (absent on a backend where opening still includes it).
  stage.*   the parts of an open, called in this process on the long conversation: the event log
            read, the history index, the newest page, the task usage.

Usage (from any directory; the backend runs from <backend_root> with this interpreter):
  python scripts/bench_open_thread.py <backend_root> <home> <workdir> [turns] [tools_per_turn]

The same <home> can be measured with two backend roots to compare them: the conversations are
written once and kept. Prints one JSON line.
"""
import json
import os
import subprocess
import sys
import threading
import time
import uuid

ROOT, HOME, WORK = (os.path.abspath(value) for value in sys.argv[1:4])
TURNS = int(sys.argv[4]) if len(sys.argv) > 4 else 150
TOOLS = int(sys.argv[5]) if len(sys.argv) > 5 else 60
ENV = {"CLEO_HOME": HOME, "CLEO_CONFIG_PATH": os.path.join(HOME, "cleo.json"),
       "CLEO_HARNESSES_CONFIG_PATH": os.path.join(HOME, "harnesses.json"),
       "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
SESSIONS = {"short": (3, 4), "long": (TURNS, TOOLS)}


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
                          "options": {"approval_mode": "deny_all", "sandbox": "read-only"}}}}, handle)


def turn_events(name, turn, tools):
    """One turn as a harness records it: the question, tool calls with output, the reply, usage."""
    events = [{"type": "user_message", "actor": "user", "content": f"{name} question {turn}"}]
    for tool in range(tools):
        call = f"{name}-{turn}-{tool}"
        # Most output is a screenful; every tenth is a long build log.
        output = f"line of output for {call}\n" * (2000 if tool % 10 == 9 else 60)
        events += [
            {"type": "tool_call", "actor": "agent", "data": {"payload": {"item": {
                "id": call, "tool": "shell", "command": f"run step {tool} of turn {turn}"}}}},
            {"type": "tool_result", "actor": "agent", "data": {"payload": {"item": {
                "id": call, "status": "completed", "output": output}}}},
        ]
    events += [
        {"type": "assistant_message", "actor": "agent", "content": f"{name} answer {turn}. " * 40},
        {"type": "usage", "actor": "agent", "data": {"call_id": f"{name}-usage-{turn}", "usage": {
            "input_tokens": 12000 + turn, "output_tokens": 800, "cache_read_input_tokens": 9000}}},
    ]
    return events


def seed(store):
    """Write the conversations once. Output: {name: session id}; a third, empty one is current."""
    from cleo.runtime.state import Runtime

    known = {row["id"] for row in store.list_sessions()}
    for name, (turns, tools) in SESSIONS.items():
        session_id = f"bench-{name}"
        if session_id in known:
            continue
        store.create_session(session_id=session_id, space="productivity", project="bench",
                             provider="codex", owner_type="user", cwd=WORK)
        for turn in range(turns):
            store.append_events(space="productivity", project="bench", session_id=session_id,
                                events=turn_events(name, turn, tools))
    if "bench-current" not in known:
        # The workspace opens its current conversation in full; keep that cost out of the others.
        store.create_session(session_id="bench-current", space="productivity", project="bench",
                             provider="codex", owner_type="user", cwd=WORK)
        store.append_events(space="productivity", project="bench", session_id="bench-current",
                            events=turn_events("current", 0, 1))
    Runtime().update_current_thread_id("bench-current")
    return {name: f"bench-{name}" for name in SESSIONS}


class Backend:
    def __init__(self):
        self.process = subprocess.Popen(
            [sys.executable, "-m", "cleo.desktop.server"], cwd=ROOT, env={**os.environ, **ENV},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1)
        self.waiters = {}
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            waiter = self.waiters.get(message.get("id"))
            if waiter is not None and message["type"] != "event":
                waiter(message, time.perf_counter())

    def request(self, method, params=None, timeout=600):
        """Output: (seconds from sending to the result arriving, the result)."""
        request_id = str(uuid.uuid4())
        done = threading.Event()
        record = {}

        def on_message(message, now):
            record.update(message=message, at=now)
            done.set()

        self.waiters[request_id] = on_message
        sent = time.perf_counter()
        self.process.stdin.write(json.dumps({"id": request_id, "method": method,
                                             "params": params or {}}) + "\n")
        self.process.stdin.flush()
        if not done.wait(timeout):
            raise TimeoutError(method)
        if record["message"]["type"] == "error":
            raise RuntimeError(f"{method}: {record['message']['error']}")
        return record["at"] - sent, record["message"].get("result")

    def close(self):
        try:
            self.request("shutdown", timeout=60)
        except Exception:
            pass
        try:
            self.process.wait(30)
        except subprocess.TimeoutExpired:
            self.process.kill()


def opens(sessions, indexes, label, results):
    """Open each conversation on a fresh backend, as a click in the sidebar does, then again."""
    backend = Backend()
    backend.request("load_workspace")
    # The first screen starts importing the harness SDKs in the background; the conversations
    # are opened once that is over, as they are in an application that has been open for a while.
    time.sleep(float(os.environ.get("BENCH_SETTLE", "10")))
    for name, session_id in sessions.items():
        seconds, thread = backend.request("load_thread", {"thread_id": session_id})
        results[f"open.{name}.{label}.first"] = seconds
        assert thread["items"], f"{name} opened without its newest page"
        again = []
        for _ in range(3):
            # Switching away and back: another conversation is opened in between.
            backend.request("load_thread", {"thread_id": "bench-current"})
            again.append(backend.request("load_thread", {"thread_id": session_id})[0])
        results[f"open.{name}.{label}.again"] = sorted(again)[1]
        if label == "index_ready":
            seconds, page = backend.request("load_timeline", {"thread_id": session_id})
            results[f"page.{name}.latest"] = seconds
            if page["hasBefore"]:
                seconds, _ = backend.request("load_timeline", {
                    "thread_id": session_id, "direction": "before", "cursor": page["before"]})
                results[f"page.{name}.before"] = seconds
            try:
                results[f"usage.{name}"] = backend.request(
                    "load_task_usage", {"thread_id": session_id})[0]
            except RuntimeError:
                pass
    # The next backend starts on the conversation that is not measured.
    backend.request("load_thread", {"thread_id": "bench-current"})
    backend.close()


def timed(call):
    started = time.perf_counter()
    value = call()
    return time.perf_counter() - started, value


def main():
    prepare_home()
    os.environ.update(ENV)
    sys.path.insert(0, ROOT)
    os.chdir(ROOT)
    from cleo.config.settings import settings
    from cleo.desktop.timeline import TimelineIndex
    from cleo.runtime.task_usage import task_usage
    from cleo.sessions.store import SessionStore

    store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
    sessions = seed(store)
    indexes = {name: TimelineIndex(store, store.load_manifest(session_id)).path
               for name, session_id in sessions.items()}
    results = {}
    for name, path in indexes.items():
        source = path.with_name("events.jsonl")
        results[f"data.{name}.megabytes"] = os.path.getsize(source) / 1e6
        with open(source, "rb") as handle:
            results[f"data.{name}.events"] = sum(1 for _ in handle)
    for path in indexes.values():
        path.unlink(missing_ok=True)
    opens(sessions, indexes, "index_missing", results)
    opens(sessions, indexes, "index_ready", results)

    manifest = store.load_manifest(sessions["long"])
    results["stage.long.read_events"], _ = timed(lambda: store.read_events(manifest["id"]))
    results["stage.long.index_unchanged"], _ = timed(
        lambda: TimelineIndex(store, manifest).recent_events())
    results["stage.long.newest_page"], _ = timed(lambda: TimelineIndex(store, manifest).page())
    results["stage.long.editable_turns"], _ = timed(
        lambda: TimelineIndex(store, manifest).editable_turns())
    results["stage.long.task_usage"], _ = timed(lambda: task_usage(store, manifest["id"]))
    indexes["long"].unlink()
    results["stage.long.index_rebuild"], _ = timed(
        lambda: TimelineIndex(store, manifest).recent_events())
    print(json.dumps({key: round(value, 3) for key, value in results.items()}))


main()
