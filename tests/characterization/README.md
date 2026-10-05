# Backend characterization tests (v0.7.1 baseline)

Black-box golden-master tests that pin the observable behaviour of the Python backend before
the backend refactor. Each test starts a real `python -m cleo.desktop.server` process with an
isolated `CLEO_HOME` and talks to it over JSON lines, exactly like `ui/electron/backend.mjs`.
Only the network/process boundary is faked: an OpenAI-compatible HTTP server for chat models
(`support/fake_llm.py`) and a scripted ACP agent for development tasks
(`support/fake_acp_agent.py`).

```bash
.venv/Scripts/python.exe -m pytest tests/characterization -q
CLEO_UPDATE_GOLDEN=1 .venv/Scripts/python.exe -m pytest tests/characterization -q  # re-record
```

- `golden/`: normalized snapshots; review their diff whenever you re-record.
- `fixtures/legacy_home_v0_7_1/`: data written by v0.7.1. Never regenerate it with newer code.

Scope, rationale, pinned defects (Q1–Q12) and the target architecture are documented in
`docs/refactor/CHARACTERIZATION_TESTS.md` and `docs/refactor/BACKEND_ARCHITECTURE_V2.md`.
