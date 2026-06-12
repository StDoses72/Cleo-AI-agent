# Cleo AI Agent

Cleo AI Agent is a local-first personal AI agent runtime built on Deep Agents
and LangChain for API-backed language models. Cleo keeps configuration, runtime
state, thread snapshots, project memory, workspace files, and the restricted
shell tool local; model inference is provided by the API provider configured in
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
- Thread snapshots saved on exit, reset, interruption, and one-shot completion.
- Resume prompt on startup when `current_thread_id` points to an unfinished thread.
- DreamAgent memory consolidation from thread snapshots into project memory.
- Restricted shell tool with allowlist, denylist, sandbox root, timeout, and audit log settings.
- Deep Agents skills loading from `skills/`; the currently tracked skill is `demo-production`.
- Automatic creation of `data/runtime.json` with a default runtime state when it is missing.

## Project Structure

```text
Cleo-AI-agent/
  main.py                         # CLI entry point
  pyproject.toml                  # Python project metadata and dependencies
  requirements.txt                # Compatibility wrapper that delegates to -e .
  config/
    settings.py                   # Pydantic settings loader and profile models
    cleo.example.json             # Local config template
    cleo.json                     # Local private config, ignored by Git
  core/
    agent.py                      # Cleo / DreamAgent construction
    memory/thread_memory.py       # Thread snapshot serialization
    runtime/model.py              # data/runtime.json read/write model
  tools/
    shell_tools.py                # Restricted shell tool
    dream_agent_tools.py          # DreamAgent memory tools
  skills/
    demo-production/              # Currently available skill
    demo-production/agents/       # Skill-local agent config
  memory/
    AGENT.md                      # Global memory policy
    thread_objects/               # Runtime generated thread message snapshots
    threads.jsonl                 # Runtime generated thread snapshot registry
    projects/                     # Runtime generated long-term project memory
  data/
    .gitkeep
    runtime_example.json          # Reference runtime state template
    runtime.json                  # Runtime generated local state, ignored by Git
    shell_audit.log               # Runtime generated shell tool audit log
  workspace/                      # Optional local workspace inputs/outputs
  docs/
    ARCHITECTURE.md
    ARCHITECTURE.en.md
```

`config/cleo.json`, `data/runtime.json`, `data/shell_audit.log`,
`memory/thread_objects/`, `memory/threads.jsonl`, and `memory/projects/` are local
configuration or runtime state and should not be committed.

## Installation

Python 3.12 or newer is recommended.

```bash
pip install -e .
```

Development dependencies:

```bash
pip install -e ".[dev]"
```

`requirements.txt` is only a compatibility entry point for older setup notes.
Prefer managing dependencies through `pyproject.toml`.

## Local Configuration

Cleo no longer uses `.env` as a configuration source. The configuration entry
point is `config/cleo.json`.

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
				"memory_agent_path": "memory/AGENT.md",
				"memory_projects_dir": "memory/projects",
				"thread_objects_dir": "memory/thread_objects",
				"thread_registry_path": "memory/threads.jsonl",
				"runtime_state_path": "data/runtime.json"
			}
		},
		"shell": {
			"default": {
				"sandbox_root": ".",
				"audit_log_path": "data/shell_audit.log",
				"require_allowlist": true,
				"enforce_sandbox": true,
				"require_approval": false,
				"timeout_seconds": 30,
				"max_output_chars": 12000,
				"allowed_commands": ["python", "python.exe", "py", "py.exe"],
				"denied_patterns": ["&&", "||", ";", "|", ">", "<", "`", "$(", "../", "..\\"]
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

- `/quit` or `/exit`: save the current thread snapshot, run DreamAgent memory consolidation, then exit.
- `/reset`: save the current thread snapshot and start a new thread.
- `/attach`: attach an image file to the next message.

## Runtime Files

These files are maintained by the code at runtime:

- `data/runtime.json`: current project, current thread, and recent threads. It is generated automatically when missing.
- `data/shell_audit.log`: restricted shell tool audit log.
- `memory/thread_objects/{thread_id}.json`: thread message snapshot.
- `memory/threads.jsonl`: thread snapshot metadata registry.
- `memory/projects/<project>/AGENT.md`: long-term project memory generated by DreamAgent.

`Runtime` stores only current state and indexes. The conversation content itself
lives in thread snapshots.

## Current Limits

- There is no `/threads` or `/switch <thread_id>` command for freely switching between historical threads yet.
- Current resume is message snapshot replay, not a full durable LangGraph checkpoint.
- Full interrupt/resume handling for `SHELL_REQUIRE_APPROVAL=True` is not implemented in the CLI yet.
- `skills/` currently only contains `demo-production`.
