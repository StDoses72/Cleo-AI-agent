# Cleo Architecture

This document describes the Cleo AI Agent local runtime architecture that
actually exists in the current repository. Cleo is a local personal AI agent
runtime built on Deep Agents and LangChain, with inspectable local workspace
access, thread snapshots, DreamAgent memory, a local shell tool, and skills
loading.

Chinese version: [ARCHITECTURE.md](ARCHITECTURE.md)

## Architecture Goals

- Use Deep Agents as the main agent execution environment.
- Use LangChain for model initialization and tool-calling paths.
- Use the Deep Agents filesystem backend to expose project files.
- Use `skills/` as the extension point for capabilities.
- Use `memory/` for inspectable and portable long-term memory.
- Use `data/runtime.json` for CLI-level runtime state.
- Use a local shell tool for scripts and diagnostics with audit logging.

## Top-Level Structure

```text
Cleo-AI-agent/
  main.py
  config/
  core/
  tools/
  skills/
  memory/
  data/
  workspace/
  docs/
```

- `main.py`: CLI entry point for one-shot messages, interactive chat, thread lifecycle, and image attachments.
- `config/`: Pydantic settings models and profile templates. The real `config/cleo.json` is ignored by Git.
- `core/`: agent construction, runtime state model, and thread memory serialization.
- `tools/`: LangChain tools used by Cleo or DreamAgent.
- `skills/`: Deep Agents skill directory. `demo-production` is the current tracked skill.
- `memory/`: global memory policy, thread snapshots, and project long-term memory.
- `data/`: runtime state, audit logs, and future local data.
- `workspace/`: user input files, temporary workflow state, and generated outputs.
- `docs/`: architecture documentation and migration notes.

## Runtime Layers

### 1. CLI Entry Layer

File: `main.py`

Responsibilities:

- Parse command-line arguments.
- Create `Agent()` and `Runtime()`.
- Generate local thread ids in the form `local-{12_hex_chars}`.
- Handle `/quit`, `/exit`, `/new`, and `/attach` in interactive mode.
- Save thread snapshots on exit, new-thread creation, interruption, or one-shot completion.
- Run DreamAgent memory consolidation on clean exit and one-shot completion.

### 2. Agent Runtime Layer

File: `core/agent.py`

Responsibilities:

- Read validated active profiles from the default `config/cleo.json` or the
  path selected through `CLEO_CONFIG_PATH`.
- Initialize the model with `langchain.chat_models.init_chat_model`.
- Create the main Cleo agent with `create_deep_agent`.
- Expose the project virtual filesystem through `FilesystemBackend(root_dir=repo_root, virtual_mode=True)`.
- Use `InMemorySaver` as the current LangGraph checkpointer.
- Inject the `run_shell_command` tool.
- Load `/skills` and the developer-owned `/memory/MEMORY_POLICY.md`.

Current behavior:

- If the active config path is missing, Cleo creates a default template and asks the user to fill it in.
- `InMemorySaver` only persists LangGraph state inside the current process.
- Thread resume relies on replaying message snapshots, not restoring a full durable graph checkpoint.

### 3. DreamAgent Layer

Files: `core/agent.py`, `tools/dream_agent_tools.py`,
`core/memory/compaction.py`, `core/memory/state.py`, and `core/memory/store.py`

Responsibilities:

- Build a deterministic, redacted compact view after saving the raw snapshot.
- Let DreamAgent read only compact views whose source hash still matches raw data.
- Read existing project memory under `memory/projects/<project>/`.
- Store atomic facts, decisions, constraints, preferences, corrections, and open
  questions in SQLite with message evidence from the current source.
- Atomically render `memory/projects/<project>/MEMORY.md`; its atomic-memory index
  is generated from SQLite.
- Advance `memory_state.json` only after Markdown succeeds and an explicit
  completion tool validates the source-backed memory count.

Write-ownership boundaries:

- `AGENTS.md` is user/team-approved guidance and changes only on an explicit user request.
- `memory/MEMORY_POLICY.md` is a developer-owned extraction policy that DreamAgent reads only.
- `memory/projects/<project>/MEMORY.md` is rebuildable descriptive memory written by DreamAgent.
- `skills/` changes only on an explicit user request; memory is never promoted automatically
  into repository instructions or skills.

Current trigger points:

- `/quit` and `/exit` trigger DreamAgent after a clean interactive exit.
- One-shot messages trigger DreamAgent after completion.
- `/new`, EOF, and KeyboardInterrupt currently save thread snapshots but do not run DreamAgent.

### 4. Runtime State Layer

File: `core/runtime/model.py`

State file: `data/runtime.json`

Fields:

```json
{
  "current_project": null,
  "current_thread_id": null,
  "projects_list": ["general"],
  "recent_threads": []
}
```

Responsibilities:

- Read current CLI state.
- Update the current project.
- Update the current thread id.
- Maintain a recent thread list.
- Sync project names from `memory/projects/`.

Current behavior:

- If `data/runtime.json` is missing, Runtime creates it with the default state.

### 5. Thread Snapshot Layer

File: `core/memory/thread_memory.py`

Generated files:

- `memory/thread_objects/{thread_id}.json`
- `memory/compact_threads/{thread_id}.json`
- `memory/threads.jsonl`
- `memory/memory.sqlite3`
- `memory/memory_state.json`

Responsibilities:

- Serialize LangChain messages with `messages_to_dict`.
- Atomically save the authoritative thread message snapshot.
- Merge tool calls/results, omit large file-read/write bodies, preserve structured
  JSON, redact common credential fields, and record source hashes and statistics.
- Build Human-led conversation chunks and idempotently replace the thread's
  SQLite index; the main Agent uses project-bound local lexical retrieval tools.
- Append thread registry metadata.
- Reload historical messages with `messages_from_dict`.

A derived-layer failure does not undo a successfully written raw snapshot.
History retrieval also checks each SQLite chunk's source hash against the current
compact file so stale index entries are not returned.

### 6. Configuration Layer

File: `config/settings.py`

Reads:

- `config/cleo.json` by default.
- The path selected by `CLEO_CONFIG_PATH` when set; Docker images use
  `/config/cleo.json`.

Core settings:

- `active_profiles.agent` selects the active `AgentProfile`.
- `active_profiles.directory` selects the active `DirectoryProfile`.
- `active_profiles.shell` selects the active `ShellProfile`.
- `active_profiles.tools` selects the active `ToolsProfile`.
- Directory profile paths resolve relative to the project root unless absolute.
- The memory pipeline uses `thread_objects_dir`, `compact_threads_dir`,
  `thread_registry_path`, `memory_database_path`, `memory_state_path`, and
  `memory_projects_dir`.

Shell tool settings:

- `sandbox_root`
- `audit_log_path`
- `require_allowlist`
- `enforce_sandbox`
- `require_approval`
- `timeout_seconds`
- `max_output_chars`
- `allowed_commands`
- `include_platform_defaults`
- `denied_patterns`

The shell tool enforces the allowlist, denylist, approval, and sandbox settings.
`include_platform_defaults` defaults to `true` and adds basic Windows or POSIX
commands so one `cleo.json` can be portable. Set it to `false` to use only the
configured allowlist. `sandbox_root` is the default working directory when no
explicit working directory is provided.

### 7. Local Shell Tool Layer

File: `tools/shell_tools.py`

Tool: `run_shell_command`

Responsibilities:

- Run local PowerShell/system shell commands for the user.
- Translate Deep Agents virtual paths into real project paths.
- Use the configured project root as the default working directory.
- Apply timeout and output truncation.
- Write every attempt to `data/shell_audit.log`.

Virtual path mapping:

```text
/workspace -> repo root
/config    -> repo/config
/core      -> repo/core
/data      -> repo/data
/docs      -> repo/docs
/memory    -> repo/memory
/skills    -> repo/skills
/tools     -> repo/tools
```

### 8. Skills Layer

Directory: `skills/`

Currently present:

```text
skills/
  demo-production/
    SKILL.md
    agents/openai.yaml
```

Responsibilities:

- Provide local skill instructions and agent configuration for Deep Agents.
- Future domain capabilities should be migrated as independent skill directories.

### 9. Workspace Layer

Directory: `workspace/`

Responsibilities:

- Store user input files.
- Store temporary workflow state.
- Store outputs generated by agents or scripts.

The currently tracked workspace files should be treated as user workspace files
or migration validation inputs, not runtime state generated by the current core
code.

## File Source Classification

### Source Code And Handwritten Assets

- `main.py`
- `config/settings.py`
- `core/**/*.py`
- `tools/**/*.py`
- `skills/demo-production/SKILL.md`
- `skills/demo-production/agents/openai.yaml`
- `AGENTS.md`
- `memory/MEMORY_POLICY.md`
- `pyproject.toml`
- `requirements.txt`
- `config/cleo.example.json`
- `data/runtime_example.json`
- `README.md`
- `docs/ARCHITECTURE.md`

### Local Private Configuration

- `config/cleo.json`

These files are copied from templates and maintained locally. They should not be committed.

### Runtime Generated Or Runtime Maintained

- `data/runtime.json`
- `data/shell_audit.log`
- `memory/thread_objects/{thread_id}.json`
- `memory/threads.jsonl`
- `memory/projects/<project>/MEMORY.md`

### Workspace Inputs Or Temporary Artifacts

- `workspace/*`

Workspace STL and PPTX files should be treated as user workspace files or
migration validation inputs.

## Resume Mechanism

Current resume is message snapshot resume:

1. Read `data/runtime.json` on startup.
2. If `current_thread_id` exists, ask the user whether to continue.
3. If confirmed, read `memory/thread_objects/{thread_id}.json`.
4. Restore LangChain messages with `messages_from_dict`.
5. Pass restored history plus the next user message into Deep Agents.

Known limits:

- Tool state, graph internal state, and checkpoint metadata are not fully restored.
- The current implementation keeps the Deep Agents / LangChain main path unchanged.
