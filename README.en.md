# Cleo AI Agent

Cleo AI Agent is a local-first personal AI agent runtime built on Deep Agents
and LangChain for API-backed language models. Cleo keeps configuration, runtime
state, session event logs, project memory, workspace files, and the local shell
tool local; model inference is provided by the API provider configured in
`config/cleo.json`.

This README describes only the capabilities that currently exist in the tracked
repository. It does not present future plans as implemented features.

Chinese version: [README.md](README.md)

## Current Capabilities

- One-shot messages through `cleo "..."` or `python main.py "..."`.
- Interactive chat through `cleo` or `python main.py`.
- API-backed model profiles loaded from the active agent profile in `config/cleo.json`.
- Pydantic settings in `config/settings.py` for agent, directory, shell, and tools profiles.
- Image attachments in interactive chat through `/attach`; JPEG, PNG, WebP, and GIF are supported.
- Append-only session events with an atomically updated manifest after each completed turn.
- Resume prompt on startup when `current_thread_id` points to an unfinished thread.
- Layered memory derived from authoritative event logs: redacted compact views, SQLite history chunks, and atomic durable memory with event evidence.
- Separate `non_productivity` and `productivity` spaces for sessions, projects, and memory.
- DreamAgent consolidation reads only source-hash-validated compact views before updating project memory.
- Project-bound tools separately retrieve stable long-term memory and detailed historical discussion.
- Local shell tool with timeout, output truncation, default working directory, and audit log settings.
- Deep Agents skills loading from `skills/`; the currently tracked skill is `demo-production`.
- Automatic creation of `data/runtime.json` with a default runtime state when it is missing.

## Project Structure

```text
Cleo-AI-agent/
  AGENTS.md                       # Human-approved repository instructions
  main.py                         # CLI entry point
  pyproject.toml                  # Python project metadata and dependencies
  requirements.txt                # Compatibility wrapper that delegates to -e .
  config/
    settings.py                   # Pydantic settings loader and profile models
    cleo.example.json             # Local config template
    cleo.json                     # Local private config, ignored by Git
  core/
    agent.py                      # Cleo / DreamAgent construction
    memory/compaction.py          # Deterministic compact/redacted event view
    memory/paths.py               # Space/project/session path boundaries
    memory/session_store.py       # Manifests, JSONL events, and session registry
    memory/state.py               # Memory source version and completion state
    memory/store.py               # SQLite memory, evidence, and history chunks
    runtime/model.py              # data/runtime.json read/write model
  tools/
    shell_tools.py                # Local shell tool
    dream_agent_tools.py          # DreamAgent memory tools
    memory_tools.py               # Project-bound retrieval tools
  skills/
    demo-production/              # Currently available skill
    demo-production/agents/       # Skill-local agent config
  memory/
    MEMORY_POLICY.md              # Developer-owned memory extraction policy
    sessions.sqlite3              # Global rebuildable session metadata index
    non_productivity/projects/    # Personal/general sessions and memory
    productivity/projects/        # Harness sessions and project memory
  data/
    .gitkeep
    runtime_example.json          # Reference runtime state template
    runtime.json                  # Runtime generated local state, ignored by Git
    shell_audit.log               # Runtime generated shell tool audit log
  workspace/                      # Optional local workspace inputs/outputs
  docs/
    ARCHITECTURE.md
    ARCHITECTURE.en.md
    CASTMIND_MEMORY_MIGRATION.md
```

`config/cleo.json`, `data/runtime.json`, `data/shell_audit.log`,
`memory/sessions.sqlite3`, `memory/non_productivity/`, and
`memory/productivity/` are
local configuration or runtime state and should not be committed.

`AGENTS.md` contains repository guidance explicitly maintained by the user or
team. `memory/MEMORY_POLICY.md` is the developer-owned extraction policy, while
`memory/<space>/projects/<project>/MEMORY.md` is DreamAgent-generated derived memory.
Automatic memory never edits `AGENTS.md` or creates or updates skills.

## Installation

Python 3.12 or newer is recommended.

```bash
pip install -e .
```

Development dependencies:

```bash
pip install -e ".[dev]"
```

`pyproject.toml` is the only manually maintained source for direct dependencies.
`requirements.txt` is the exact Linux container lock file and should not be edited
manually.

## Dependency Updates and Docker

Docker does not replace dependency manifests: `pyproject.toml` describes project
dependencies, `requirements.txt` locks resolved versions, and Docker installs that
lock file to produce a repeatable runtime.

Regenerate the lock file and build the image with one command:

```bash
python scripts/update_project.py
```

For networks where the official index is slow, use a mirror and keep official
PyPI as a fallback for Codex pre-release packages that may not be mirrored:

```bash
python scripts/update_project.py --index-url https://pypi.tuna.tsinghua.edu.cn/simple --extra-index-url https://pypi.org/simple
```

Update only the lock file without building the application image:

```bash
python scripts/update_project.py --skip-build
```

After a local build, Compose mounts the existing `config/cleo.json`; a separate
Docker-specific profile is not required:

```bash
docker compose run --rm cleo
docker compose run --rm cleo "Describe the current project"
```

The same `cleo.json` works for local Windows and Linux Docker runs. Cleo adds
appropriate shell commands for the current platform automatically. Set
`include_platform_defaults: false` to manage the allowlist entirely yourself.

After publishing to Docker Hub or GHCR, users do not need to clone GitHub. They
can generate a config directly from the image (replace `<image>` with the real
image name):

```powershell
cmd /c "docker run --rm <image> --print-config-template > cleo.json"
notepad cleo.json
```

After filling in model settings and an API key, run:

```powershell
docker run --rm -it `
  --mount "type=bind,source=$($PWD.Path)\cleo.json,target=/config/cleo.json,readonly" `
  --mount "type=volume,source=cleo-data,target=/app/data" `
  --mount "type=volume,source=cleo-memory,target=/app/memory" `
  --mount "type=volume,source=cleo-workspace,target=/app/workspace" `
  --mount "type=volume,source=cleo-codex-home,target=/home/cleo/.codex" `
  <image>
```

This direct-run example uses named volumes to persist `data/`, `memory/`,
`workspace/`, and Codex login state. When using the project Compose file,
`workspace/` is bind-mounted from the host by default. No network port is
exposed because Cleo and its MCP server are currently CLI/stdio processes.

## Local Configuration

Cleo no longer uses `.env` as a configuration source. Local runs use
`config/cleo.json` by default; containers set
`CLEO_CONFIG_PATH=/config/cleo.json` and mount the same config format there.

Before the first run, you can copy the template manually:

```bash
copy config\cleo.example.json config\cleo.json
```

You can also run Cleo directly. If `config/cleo.json` is missing, Cleo creates a
default template and asks you to fill in real profile settings.

`config/cleo.json` stores multiple profile registries in one JSON file:

```json
{
	"active_profiles": {
		"agent": "moonshot_openai_compatible",
		"directory": "default",
		"shell": "default",
		"tools": "default"
	},
	"profiles": {
		"agents": {
			"moonshot_openai_compatible": {
				"provider": "openai",
				"model": "kimi-k2.6",
				"temperature": 0.7,
				"max_tokens": 100000,
				"api_key": "YOUR_API_KEY",
				"base_url": "https://api.moonshot.cn/v1"
			}
		},
		"directories": {
			"default": {
				"root_dir": ".",
				"data_dir": "data",
				"skills_dir": "skills",
				"workspace_dir": "workspace",
				"memory_dir": "memory",
				"memory_policy_path": "memory/MEMORY_POLICY.md",
				"session_index_path": "memory/sessions.sqlite3",
				"session_artifacts_dir": "data/session_artifacts",
				"runtime_state_path": "data/runtime.json"
			}
		},
		"shell": {
			"default": {
				"sandbox_root": ".",
				"audit_log_path": "data/shell_audit.log",
				"require_allowlist": false,
				"enforce_sandbox": false,
				"require_approval": false,
				"timeout_seconds": 30,
				"max_output_chars": 12000,
				"allowed_commands": ["python", "git"],
				"include_platform_defaults": true,
				"denied_patterns": []
			}
		},
		"tools": {
			"default": {
				"tavily_api_key": null
			}
		}
	}
}
```

`active_profiles` stores the selected profile names. `profiles` stores all
available profile definitions. Pydantic validates the JSON, and the runtime code
uses `settings.active_agent_profile`, `settings.active_directory_profile`,
`settings.active_shell_profile`, and `settings.active_tools_profile` to access
the active configuration.

## Running

One-shot message:

```bash
cleo "Summarize what the current Cleo project can do."
```

Bind the thread and both retrieval tools to a project:

```bash
cleo --project cleo "Review why we designed the memory system this way."
```

Or:

```bash
python main.py "Summarize what the current Cleo project can do."
```

Interactive chat:

```bash
cleo
```

Or:

```bash
python main.py
```

Interactive commands:

- `/quit` or `/exit`: close the current event log, run DreamAgent consolidation, then exit.
- `/new`: complete the current session and start a new thread.
- `/resume <session-id>`: resume a saved Cleo thread inside the current CLI.
- `/productivity`: open Codex productivity mode; use `/back` or `/quit` there to return.
- `/sessions`: open the cross-space Session Hub with provider, project, and status metadata.
- `/attach`: attach an image file to the next message.

Type `/` and press `Tab` to list commands for the current mode. After `/resume`,
press `Tab` to complete resumable session IDs.

Interactive mode also accepts `cleo --project <name>`. `/new` keeps the same
project binding. `--resume` restores the space/project stored in the manifest and
rejects a conflicting `--project` argument.

The recommended interactive entry is `/productivity` from the main chat. Codex
productivity mode can also be started directly from the command line:

```bash
# Continuous interaction
python main.py --productivity --project cleo --cwd .

# One-shot task
python main.py --productivity --cwd . "Inspect the current changes and run tests"

# Resume the Codex native session associated with a Cleo session id
python main.py --productivity --resume agent_xxx
```

Use `--model` to override `profiles.tools.<name>.codex_model`. Productivity mode
supports:

- `/cwd`: show the harness working directory.
- `/cd <directory>`: change directory and create a new harness session; relative
  paths are resolved from the current `cwd`.
- `/resume <agent-id>`: resume a saved productivity session and its native harness context.
- `/new`, `/sessions`, `/back`, `/quit`, and `/exit`: manage the session or leave the view.

Codex SDK message, tool, terminal, plan, and file-change events stream to the
console and are normalized into the `productivity` space. CLI completion and the
Rich presentation layer live in `core/cli.py` and contain no runtime, memory, or
provider business logic.

## Runtime Files

These files are maintained by the code at runtime:

- `data/runtime.json`: current space/project/thread and space-partitioned recent threads.
- `data/shell_audit.log`: local shell tool audit log.
- `memory/sessions.sqlite3`: global rebuildable session metadata registry.
- `memory/<space>/projects/<project>/sessions/<session>/manifest.json`: current session projection.
- `memory/<space>/projects/<project>/sessions/<session>/events.jsonl`: append-only evidence.
- `memory/<space>/projects/<project>/sessions/<session>/compact.json`: redacted compact projection.
- `memory/<space>/memory.sqlite3`: durable memory, event evidence, and conversation chunks.
- `memory/<space>/memory_state.json`: source versions, hashes, Dream status, and failures.
- `memory/<space>/projects/<project>/MEMORY.md`: DreamAgent-generated long-term memory.

`Runtime` stores only current CLI state. Append-only event logs are authoritative
interaction history, while manifests hold current metadata. Compact files,
SQLite indexes, and project `MEMORY.md` files are rebuildable. See
[`docs/CASTMIND_MEMORY_MIGRATION.md`](docs/CASTMIND_MEMORY_MIGRATION.md) for the
migration review and tradeoffs.

## Current Limits

- There is no `/threads` or `/switch <thread_id>` command for freely switching between historical threads yet.
- Current resume is session message event replay, not a full durable LangGraph checkpoint.
- Historical retrieval currently uses local lexical ranking; uncalibrated vector retrieval is not enabled.
- `skills/` currently only contains `demo-production`.
