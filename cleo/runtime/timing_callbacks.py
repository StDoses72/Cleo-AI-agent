"""Observe actual LangChain call boundaries without changing streamed model content."""

from langchain_core.callbacks import AsyncCallbackHandler

from cleo.runtime.timing import current_timing


class TimingCallbacks(AsyncCallbackHandler):
    def __init__(self, recorder):
        self.recorder = recorder
        self.calls = {}

    def _start(self, run_id, label, category):
        if run_id not in self.calls:
            self.calls[run_id] = self.recorder.start(label, category=category)

    def _end(self, run_id, status):
        self.recorder.end(self.calls.pop(run_id, None), status)

    async def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):
        self._start(run_id, "模型响应（等待与生成）", "model")

    async def on_llm_start(self, serialized, prompts, *, run_id, **kwargs):
        self._start(run_id, "模型响应（等待与生成）", "model")

    async def on_llm_end(self, response, *, run_id, **kwargs):
        self._end(run_id, "completed")

    async def on_llm_error(self, error, *, run_id, **kwargs):
        self._end(run_id, "failed")

    async def on_tool_start(self, serialized, input_str, *, run_id, **kwargs):
        name = (serialized or {}).get("name") or "工具"
        self._start(run_id, str(name), "tool")

    async def on_tool_end(self, output, *, run_id, **kwargs):
        self._end(run_id, "completed")

    async def on_tool_error(self, error, *, run_id, **kwargs):
        self._end(run_id, "failed")


def timing_config():
    recorder = current_timing.get()
    return {"callbacks": [TimingCallbacks(recorder)]} if recorder else {}
