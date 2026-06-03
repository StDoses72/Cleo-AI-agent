# AI4Casting

A deepagent-based AI agent system for casting workflows.

## Core Idea

The project keeps a lightweight local-agent architecture with a filesystem
workspace, domain skills, and a small CLI runtime. The main pieces are:

- `config/` loads environment and runtime settings.
- `core/` builds the deepagent runtime.
- `core/runtime/` tracks current CLI state in `data/runtime.json`.
- `core/memory/` serializes thread message snapshots under `memory/`.
- `skills/` contains domain guidance, deterministic workflow scripts, and output profiles.
- `workspace/` stores temporary workflow state, uploaded/linked part files, and generated results.
- `data/` stores runtime audit logs and future reference material.

## Quick Start

1. Create a local `.env` file:

```bash
OPENAI_API_KEY=
TAVILY_API_KEY=
AI4CASTING_MODEL=gpt-5.4-mini
SHELL_ALLOWED_COMMANDS=python,python.exe,py,py.exe
```

2. Install the project and dependencies:

```bash
pip install -e .
```

For development tools such as `pytest` and `ruff`, install the optional dev
dependencies:

```bash
pip install -e ".[dev]"
```

`requirements.txt` is kept as a compatibility wrapper for older workflows, so
`pip install -r requirements.txt` still works.

3. Run a smoke test:

```bash
python main.py "Summarize what this casting agent can help with."
```

4. Start interactive chat:

```bash
python main.py
```

The CLI keeps a stable local `thread_id` for each interactive session. Use
`/quit` or `/exit` to close a thread cleanly, and `/reset` to snapshot the
current thread before starting a fresh one.

## Runtime and Thread Snapshots

The current CLI runtime is stored in:

```text
data/runtime.json
```

It tracks:

- `current_project`
- `current_thread_id`
- `projects_list`
- `recent_threads`

Thread message snapshots are stored as JSON files in:

```text
memory/thread_objects/{thread_id}.json
```

Snapshot metadata is appended to:

```text
memory/threads.jsonl
```

The CLI currently snapshots thread messages on `/quit`, `/exit`, `/reset`,
`EOF`, and `KeyboardInterrupt`. Clean `/quit` clears `current_thread_id`; an
interrupted session keeps `current_thread_id` so future resume work can detect
an unfinished thread.

Resume is not implemented yet. The planned first version is to load saved
messages with LangChain message deserialization and feed them into the next
deepagent invocation so LangGraph can rebuild the active graph state.

## Current Gate Design Workflow

The main implemented workflow is `die-casting-gate-design`, a migrated version
of the v3 die-casting internal gate design flow. It uses:

- `skills/cad-geometry-extractor/` for STL geometry extraction.
- `skills/die-casting-gate-design/scripts/casting_design_process.py` for
  deterministic lookup, interpolation, internal gate sizing calculations, workflow
  advancement, and final validation.
- `skills/die-casting-gate-design/profiles/final_design_template.json` as the
  final output profile template.

The preferred calculation entry point is:

```bash
python skills/die-casting-gate-design/scripts/casting_design_process.py advance --wall-thickness-mm 2.1 --max-wall-thickness-mm 3.4 --product-volume-mm3 12000 --overflow-design-mode gate_sizing_only --alloy-type aluminum --part-complexity simple
```

When the workflow completes, the agent should fill the profile template and
write the temporary final result to:

```text
workspace/die-casting-gate-design/final_design.json
```

Incomplete workflow state may be kept at:

```text
workspace/die-casting-gate-design/state.json
```

## Shell Tool

AI4Casting includes a restricted `run_shell_command` tool for project-local
scripts. It is allowlisted, sandboxed under the project root by default, audited
to `data/shell_audit.log`, and can be configured with human approval through
deepagent `interrupt_on`.

Use `.env` to widen it only when a skill truly needs another executable:

```bash
SHELL_ALLOWED_COMMANDS=python,python.exe,py,py.exe,node
SHELL_TIMEOUT_SECONDS=30
```

## Current Skills

- `cad-geometry-extractor`: STL geometry extraction workflow.
- `die-casting-gate-design`: deterministic die-casting gate design flow.
- `pptx-ai-template-flow`: PowerPoint template parsing/filling helper flow.
- `presentations`: presentation authoring support scripts and references.

## Dependency Management

Project metadata and Python dependencies live in `pyproject.toml`.

- Runtime dependencies are listed under `[project].dependencies`.
- Development dependencies are listed under `[project.optional-dependencies].dev`.
- The `ai4casting` console command is mapped to `main:main`.
- `requirements.txt` delegates to `-e .` for compatibility and should not carry
  a separate dependency list.
