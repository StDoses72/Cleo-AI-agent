# Cleo Architecture

This document describes the Cleo local agent architecture that actually exists
in the current repository. Cleo was migrated from an older AI4Casting project,
so some `ai4casting` names and historical workspace files still remain. Unless a
file exists in the current repository, this document does not describe migrated
or future capabilities as current features.

Chinese version: [ARCHITECTURE.md](ARCHITECTURE.md)

## Architecture Goals

Cleo is currently designed as a lightweight, local, portable personal AI agent runtime:

- Use Deep Agents as the main agent execution environment.
- Use a local filesystem backend to expose project files.
- Use `skills/` as the extension point for capabilities.
- Use `memory/` for inspectable and portable long-term memory.
- Use `data/runtime.json` for CLI-level runtime state.
- Use a restricted shell tool for project-local scripts with audit logging.

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

Directory responsibilities:

- `main.py`: CLI entry point for one-shot messages, interactive chat, thread lifecycle, and attachments.
- `config/`: local settings and profile templates. The real `config/cleo.json` is ignored by Git.
- `core/`: agent construction, runtime state model, and thread memory serialization.
- `tools/`: LangChain tools used by Cleo or DreamAgent.
- `skills/`: Deep Agents skill directory. `demo-production` is the current tracked skill.
- `memory/`: global memory policy, thread snapshots, and project long-term memory.
- `data/`: runtime state, audit logs, and future local data.
- `workspace/`: user input files, temporary workflow state, and generated outputs.
- `docs/`: architecture and migration notes.

## Runtime Layers

### 1. CLI Entry Layer

File: `main.py`

Responsibilities:

- Parse command-line arguments.
- Create `Agent()` and `Runtime()`.
- Generate local thread ids in the form `local-{12_hex_chars}`.
- Handle `/quit`, `/exit`, `/reset`, and `/attach` in interactive mode.
- Save thread snapshots on exit, reset, interruption, or one-shot completion.
- Run DreamAgent memory consolidation on clean exit.

Attachment support:

- `/attach` supports image files.
- Supported MIME types: JPEG, PNG, WebP, and GIF.
- Images are base64 encoded and attached to the next user message.

### 2. Agent Runtime Layer

File: `core/agent.py`

Responsibilities:

- Read the active profile from `config/cleo.json`.
- Initialize the model with `langchain.chat_models.init_chat_model`.
- Create the main Cleo agent with `create_deep_agent`.
- Expose the project virtual filesystem through `FilesystemBackend(root_dir=repo_root, virtual_mode=True)`.
- Use `InMemorySaver` as the current LangGraph checkpointer.
- Inject the `run_shell_command` tool.
- Load `/skills` and `/memory/AGENT.md`.

Important current behavior:

- If `config/cleo.json` is missing, the current code fails while opening the file.
- `InMemorySaver` only persists LangGraph state inside the current process.
- Thread resume relies on replaying message snapshots, not restoring a full durable graph checkpoint.

### 3. DreamAgent Layer

Files: `core/agent.py`, `tools/dream_agent_tools.py`

Responsibilities:

- DreamAgent is a background memory consolidation agent.
- It reads `memory/thread_objects/{thread_id}.json`.
- It reads existing project memory under `memory/projects/<project>/`.
- It writes durable facts, decisions, preferences, corrections, and open questions to `memory/projects/<project>/AGENT.md`.

Current trigger points:

- `/quit` and `/exit` trigger DreamAgent after a clean interactive exit.
- One-shot messages trigger DreamAgent after completion.
- `/reset`, EOF, and KeyboardInterrupt currently save thread snapshots but do not run DreamAgent.

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

Current limits:

- `data/runtime.json` must already exist.
- Initialization immediately calls `sync_projects_from_disk()` and writes runtime JSON back to disk.

### 5. Thread Snapshot Layer

File: `core/memory/thread_memory.py`

Generated files:

- `memory/thread_objects/{thread_id}.json`
- `memory/threads.jsonl`

Responsibilities:

- Serialize LangChain messages with `messages_to_dict`.
- Save the current thread's message snapshot.
- Append thread registry metadata.
- Reload historical messages with `messages_from_dict`.

Notes:

- This is not a full LangGraph checkpoint.
- Current resume passes loaded messages plus the new user message into the next deepagent stream call.

### 6. Configuration Layer

File: `config/settings.py`

Reads:

- `.env`
- OS environment variables

Core paths:

- `PROFILE_DIR` -> `config/cleo.json`
- `DATA_DIR` -> `data/`
- `SKILLS_DIR` -> `skills/`
- `WORKSPACE_DIR` -> `workspace/`
- `MEMORY_DIR` -> `memory/`
- `THREAD_OBJECTS_DIR` -> `memory/thread_objects/`
- `THREAD_REGISTRY_PATH` -> `memory/threads.jsonl`
- `RUNTIME_STATE_PATH` -> `data/runtime.json`

Shell tool settings:

- `SHELL_SANDBOX_ROOT`
- `SHELL_AUDIT_LOG_PATH`
- `SHELL_REQUIRE_ALLOWLIST`
- `SHELL_ENFORCE_SANDBOX`
- `SHELL_REQUIRE_APPROVAL`
- `SHELL_TIMEOUT_SECONDS`
- `SHELL_MAX_OUTPUT_CHARS`
- `SHELL_ALLOWED_COMMANDS`
- `SHELL_DENIED_PATTERNS`

### 7. Restricted Shell Tool Layer

File: `tools/shell_tools.py`

Tool: `run_shell_command`

Responsibilities:

- Run only allowlisted commands.
- Block pipes, redirects, shell chaining, path traversal, and dangerous command patterns.
- Translate Deep Agents virtual paths into real project paths.
- Keep the working directory inside the sandbox root.
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

Notes:

- The shell sandbox constrains the process working directory.
- Trusted project scripts may still receive user-provided absolute Windows paths as input arguments.

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

Migration note:

- Older docs mentioned casting-related skill directories, but they are not present in the current tracked repository.
- Unmigrated skills should not be documented as current capabilities.

### 9. Workspace Layer

Directory: `workspace/`

Responsibilities:

- Store user input files.
- Store temporary workflow state.
- Store outputs generated by agents or scripts.

Current files:

- `workspace/product.stl`
- `workspace/双联屏-DieCasting_DFM_EON-2020.9.03.pptx`

These look like migration or domain validation inputs, not runtime state generated by the current core code.

## File Source Classification

### Source Code And Handwritten Assets

- `main.py`
- `config/settings.py`
- `core/**/*.py`
- `tools/**/*.py`
- `skills/demo-production/SKILL.md`
- `skills/demo-production/agents/openai.yaml`
- `memory/AGENT.md`
- `pyproject.toml`
- `requirements.txt`
- `.gitignore`
- `.gitattributes`
- `README.md`
- `docs/ARCHITECTURE.md`

### Local Private Configuration

- `.env`
- `config/cleo.json`

These files are copied from templates and maintained locally. They should not be committed.

### Template Files

- `.env.example`
- `config/cleo.example.json`
- `data/runtime_example.json`

### Runtime Generated Or Runtime Maintained

- `data/runtime.json`
- `data/shell_audit.log`
- `memory/thread_objects/{thread_id}.json`
- `memory/threads.jsonl`
- `memory/projects/<project>/AGENT.md`

### Workspace Inputs Or Temporary Artifacts

- `workspace/*`

The STL and PPTX files currently in the repository should be treated as migration validation inputs or user workspace files.

## Thread Lifecycle

### New Interactive Session

1. `main.py` generates a new thread id.
2. `Runtime.update_current_thread_id(thread_id)` writes it to `data/runtime.json`.
3. User messages enter deepagent through `Agent.stream_text()`.
4. LangGraph state is temporarily stored in `InMemorySaver`.

### Clean Exit

1. The user enters `/quit` or `/exit`.
2. `_save_thread_snapshot()` reads messages from deepagent state.
3. `save_messages_to_file()` writes `memory/thread_objects/{thread_id}.json`.
4. The same function appends `memory/threads.jsonl`.
5. DreamAgent consolidates long-term project memory.
6. Runtime clears `current_project` and `current_thread_id`.

### Reset

1. Save the current thread snapshot.
2. Generate a new thread id.
3. Clear the current project.
4. Write the new `current_thread_id`.

### Interruption

EOF or KeyboardInterrupt:

- Save the thread snapshot.
- Keep `current_thread_id`.
- On the next startup, ask whether to continue the unfinished thread.

## Resume Mechanism

Current resume is message snapshot resume, not durable checkpoint resume:

1. Read `data/runtime.json` on startup.
2. If `current_thread_id` exists, ask the user whether to continue.
3. If confirmed, read `memory/thread_objects/{thread_id}.json`.
4. Restore LangChain messages with `messages_from_dict`.
5. Pass restored history plus the next user message into deepagent.

Known limits:

- Tool state, graph internal state, and checkpoint metadata are not fully restored.
- If stronger recovery is needed later, Cleo should add or replace this with a durable LangGraph checkpointer.

## Configuration Automation Recommendations

Startup currently depends on several manual setup steps. A good next step is a
bootstrap module such as `core/bootstrap.py`, exposed through the CLI:

```bash
python main.py --init
python main.py --doctor
```

`--init` could:

- Copy `.env.example` to `.env` if `.env` is missing.
- Copy `config/cleo.example.json` to `config/cleo.json` if missing.
- Create `data/runtime.json` from `data/runtime_example.json` or a default dictionary if missing.
- Create `memory/thread_objects/`, `memory/projects/`, and `workspace/`.
- Avoid overwriting existing local files.

`--doctor` could check:

- Whether `.env` exists.
- Whether `config/cleo.json` exists and is valid JSON.
- Whether the active profile exists.
- Whether the API key is still a template placeholder.
- Whether `data/runtime.json` exists and has complete fields.
- Whether shell allowlist and denylist settings are empty or risky.
- Whether runtime directories are writable.

Further improvement: make `Runtime` create a default runtime JSON when missing,
and make `Agent` raise clear user-facing configuration errors when the profile
file is missing. That would make first run much smoother.

## Current Technical Debt

- Project naming still mixes `Cleo` and `ai4casting`.
- The README, package name, and console command need an explicit naming decision.
- Missing `config/cleo.json` and `data/runtime.json` errors are not user-friendly yet.
- DreamAgent works, but project selection still depends on `runtime.current_project`.
- `SHELL_REQUIRE_APPROVAL=True` interrupt/resume behavior is not fully implemented in the CLI.
- `skills/` currently only contains `demo-production`; domain skill migration is not complete.

## Recommended Evolution Order

1. Add bootstrap and doctor commands to automate local initialization.
2. Decide naming: keep `ai4casting` as a compatibility entry point or rename to `cleo`.
3. Add clear repair guidance when runtime/profile files are missing.
4. Improve project selection or project inference for DreamAgent.
5. Migrate casting, PPTX, CAD, or other domain skills into `skills/`.
6. Evaluate a durable LangGraph checkpointer.
