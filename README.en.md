# Cleo AI Agent

Cleo is a local personal AI agent project currently being migrated from an older
AI4Casting codebase. The repository still keeps some `ai4casting` package names
and CLI entry points for compatibility, but the current architecture is now a
more general Deep Agents local runtime: it can load local skills, read and write
workspace files, save thread snapshots, and use DreamAgent to consolidate short
conversations into long-term project memory.

This README describes only what currently exists in this repository. It does not
present pre-migration prototypes or future plans as implemented features.

Chinese version: [README.md](README.md)

## Current State

Implemented:

- `main.py` provides one-shot and interactive chat entry points.
- `core/agent.py` creates the main Cleo agent and the background DreamAgent.
- `config/settings.py` manages local paths, shell tool policy, runtime directories, and environment variables.
- `core/runtime/model.py` maintains CLI runtime state in `data/runtime.json`.
- `core/memory/thread_memory.py` saves and restores thread message snapshots.
- `tools/shell_tools.py` provides a restricted shell tool and writes audit logs.
- `tools/dream_agent_tools.py` lets DreamAgent read short-term memory and write project memory.
- `skills/demo-production/` is the only skill directory currently present in the tracked repository.

Migrating or not yet implemented:

- Casting workflow skill directories mentioned by older README versions are not present in the current tracked files.
- Thread resume has a first implementation: startup can detect an unfinished `current_thread_id` and load message snapshots, but the underlying LangGraph checkpointer is still in memory.
- Initial setup still requires manually copying template files. There is no `init` or `doctor` command yet.

## Project Structure

```text
Cleo-AI-agent/
  main.py                         # CLI entry point
  pyproject.toml                  # Python project metadata and dependencies
  requirements.txt                # Compatibility wrapper that delegates to -e .
  .env.example                    # Local environment template
  config/
    settings.py                   # Paths, environment variables, shell policy
    cleo.example.json             # Model profile template
    cleo.json                     # Local private profile, ignored by Git
  core/
    agent.py                      # Cleo / DreamAgent construction
    memory/thread_memory.py       # Thread snapshot serialization
    runtime/model.py              # data/runtime.json read/write model
  tools/
    shell_tools.py                # Restricted shell tool
    dream_agent_tools.py          # DreamAgent memory tools
  skills/
    demo-production/              # Currently available skill
  memory/
    AGENT.md                      # Global memory policy
    thread_objects/               # Runtime generated thread message snapshots
    threads.jsonl                 # Runtime generated thread snapshot registry
    projects/                     # Runtime generated long-term project memory
  data/
    runtime_example.json          # Runtime state template
    runtime.json                  # Local runtime state, ignored by Git
    shell_audit.log               # Runtime generated shell tool audit log
  workspace/
    product.stl                   # Current workspace input file
    双联屏-DieCasting_DFM_EON-2020.9.03.pptx
```

## Installation

Python 3.12 or newer is recommended.

```bash
pip install -e .
```

Development dependencies:

```bash
pip install -e ".[dev]"
```

`requirements.txt` is only a compatibility entry point. Prefer managing dependencies through `pyproject.toml`.

## Local Configuration

Before running Cleo, prepare three local files:

1. Copy `.env.example` to `.env` and adjust shell tool settings as needed.
2. Copy `config/cleo.example.json` to `config/cleo.json`, then fill in the real model profile and API key.
3. Copy `data/runtime_example.json` to `data/runtime.json` as the initial runtime state.

`.env`, `config/cleo.json`, and `data/runtime.json` are local files and should not be committed.

Minimal profile example:

```json
{
  "active_profiles": "moonshot_openai_compatible",
  "profiles": {
    "moonshot_openai_compatible": {
      "provider": "openai",
      "model": "kimi-k2.6",
      "temperature": 0.7,
      "api_key": "YOUR_API_KEY",
      "base_url": "https://api.moonshot.cn/v1"
    }
  }
}
```

## Running

One-shot message:

```bash
python main.py "Summarize what the current Cleo project can do."
```

Interactive chat:

```bash
python main.py
```

Interactive commands:

- `/quit` or `/exit`: save the current thread snapshot, run DreamAgent memory consolidation, then exit.
- `/reset`: save the current thread snapshot and start a new thread.
- `/attach`: attach an image file to the next message. JPEG, PNG, WebP, and GIF are currently supported.

## Runtime Files

These files are maintained by the code at runtime:

- `data/runtime.json`: current project, current thread, and recent thread list.
- `data/shell_audit.log`: restricted shell tool audit log.
- `memory/thread_objects/{thread_id}.json`: thread message snapshot.
- `memory/threads.jsonl`: thread snapshot metadata registry.
- `memory/projects/<project>/AGENT.md`: long-term project memory generated by DreamAgent.

Most of these paths are ignored by `.gitignore`. They are local state, not source assets.

## Manual Configuration And Automation Candidates

Still manual today:

- Copy `.env.example` to `.env`.
- Copy `config/cleo.example.json` to `config/cleo.json` and fill in secrets.
- Copy `data/runtime_example.json` to `data/runtime.json`.
- Create or organize workspace input files.
- Maintain skill directories and skill instructions.

Recommended automation:

- Add `cleo init` or `python main.py --init` to create missing template-based files and directories.
- Add `cleo doctor` to check config files, profiles, placeholder API keys, runtime JSON, and runtime directories.
- Let `Runtime` create a default `data/runtime.json` when it is missing.
- Let `Agent` return clear user-facing errors when `config/cleo.json` is missing or still contains placeholder secrets.

## Migration Notes

Some package names, console scripts, and historical docs still use `ai4casting`.
That is migration compatibility residue. The current project should be understood
as the Cleo local agent runtime. Casting-related capabilities should be migrated
into `skills/` as future skills rather than assumed to exist by default.
