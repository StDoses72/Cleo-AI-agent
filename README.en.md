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
- Full-screen Textual chat through `cleo` or `python main.py`, with streaming
  output, clickable memory-project and conversation pickers, attachments, and quick actions.
- A full-screen Textual productivity workspace through `cleo --productivity` or
  `/productivity`, with streaming agent output, clickable collapsible diffs, a
  project picker, click-to-resume sessions, a Git sidebar, and quick actions.
- Independently selected API-backed agent profiles for foreground Cleo and DreamAgent.
- Pydantic settings in `cleo/config/settings.py` for agent, directory, shell, and tools profiles.
- Image attachments in interactive chat through `/attach`; JPEG, PNG, WebP, and GIF are supported.
- Append-only session events with an atomically updated manifest after each completed turn.
- Automatic startup resume when `current_thread_id` points to an unfinished thread,
  plus click-to-resume from the conversation picker.
- Layered memory derived from authoritative event logs: redacted compact views, SQLite history chunks, and atomic durable memory with event evidence.
- Separate `non_productivity` and `productivity` spaces for sessions, projects, and memory.
- Interactive exits hand consolidation to a detached worker; one-shot runs consolidate
  directly. A local Sentence Transformer gate first skips clearly transient
  conversations; remaining sources reach DreamAgent, which reads only
  source-hash-validated compact views before updating project memory and global persona tendencies.
- A root-level `PERSONA.md` is shared across projects and spaces. It contains only
  evidence-backed communication, expression, relationship-continuity, adaptation,
  and interaction-boundary tendencies—not project facts, permissions, or policy.
- Project-bound tools separately retrieve stable long-term memory and detailed historical discussion.
- Local shell tool with timeout, output truncation, default working directory, and audit log settings.
- Deep Agents skills loading from `skills/`; tracked skills include `demo-production` and `agent-browser`.
- Automatic creation of `data/runtime.json` with a default runtime state when it is missing.

## Project Structure

```text
Cleo-AI-agent/
  AGENTS.md                       # Human-approved repository instructions
  PERSONA.md                      # Global descriptive persona projection
  main.py                         # Backward-compatible CLI launcher
  pyproject.toml                  # Python project metadata and dependencies
  requirements.txt                # Python 3.12/Linux container dependency lock
  scripts/
    install.ps1                   # Windows per-user installer
    update.ps1                    # Update an existing Windows installation
    uninstall.ps1                 # Remove the Windows installation
  cleo/                           # Single Python application package
    agents/
      cleo.py                     # Foreground Cleo agent
      dream.py                    # Memory-consolidation DreamAgent
      tools/                      # Agent-owned shell, memory, and Codex tools
    cli/
      application.py              # Argument parsing and top-level dispatch
      chat.py                     # Interactive Cleo chat flow
      chat_tui.py                 # Full-screen Textual Cleo chat workspace
      productivity.py             # Harness startup and backend lifecycle bridge
      productivity_tui.py         # Full-screen Textual productivity workspace
      dream_worker.py             # Detached sequential DreamAgent consolidation worker
      lifecycle.py                # Session persistence and consolidation lifecycle
      console.py                  # Compact Rich one-shot presentation
      productivity_renderer.py    # Shared harness event and usage projection
      context.py                  # Shared terminal context
      workspace.py                # Explicit workspace reset operation
    config/
      settings.py                 # Pydantic settings loader and profile models
      templates/                  # Packaged Cleo and harness config templates
    images/
      startup.py                  # Terminal startup image selection
      portrait.py                 # Rich pixel-art fallback
      sixel_encoder.py            # Transparent Sixel encoder
      assets/                     # Packaged startup image
    harnesses/                    # Provider-neutral harness API and adapter
    integrations/
      git.py                      # Read-only Git integration
      codex.py                    # Backward-compatible Codex facade
      harnesses/                  # Codex, Claude, and ACP provider implementations
    mcp/codex_server.py           # Stdio MCP process entry point
    memory/                       # Compaction, durable memory, evidence, and paths
    sessions/
      hub.py                      # Managed/native session aggregation
      store.py                    # Manifests, JSONL events, and session registry
    runtime/
      state.py                    # data/runtime.json read/write model
      usage.py                    # Shared context-window usage state
  config/                         # Local private configs, ignored by Git
  tests/                          # Tests mirror cleo/ responsibility domains
  skills/
    demo-production/              # Currently available skill
    demo-production/agents/       # Skill-local agent config
  memory/
    MEMORY_POLICY.md              # Developer-owned memory extraction policy
    persona.sqlite3               # Global persona traits and private evidence
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
`memory/sessions.sqlite3`, `memory/persona.sqlite3`, `memory/non_productivity/`, and
`memory/productivity/` are
local configuration or runtime state and should not be committed.

`AGENTS.md` contains repository guidance explicitly maintained by the user or
team. The root `PERSONA.md` is DreamAgent's global descriptive persona projection;
`memory/MEMORY_POLICY.md` is the developer-owned extraction policy, while
`memory/<space>/projects/<project>/MEMORY.md` is project-bound derived memory.
Automatic memory never edits `AGENTS.md`; persona cannot grant permissions,
define tool rules, or create or update skills.
`PERSONA.md` is rebuilt from `memory/persona.sqlite3` at startup and during
persona consolidation, so it is not a surface for untracked manual-only edits.

## Startup Portrait

The startup splash depends on one PNG. For a source checkout, replace
`cleo/images/assets/cleo-startup.png`. For a standalone installation, replace
`%LOCALAPPDATA%\Cleo\assets\startup.png`. The updater copies the default only
when this file is missing, so it does not overwrite a customized portrait.

Any image dimensions and aspect ratio are accepted and remain proportional
when fitted to the terminal. An RGBA PNG with a transparent background is
recommended. Transparent padding and detached marks that are negligible
relative to the main artwork are cropped automatically. A fully opaque PNG
uses its complete canvas. An arbitrary PNG can also be selected with
`CLEO_STARTUP_IMAGE_PATH`:

```powershell
$env:CLEO_STARTUP_IMAGE_PATH = "D:\portraits\cleo.png"
cleo
```

Compose mounts the source PNG by default; set `CLEO_STARTUP_IMAGE_FILE` to use a
different host file. Sixel, Kitty graphics, and the Rich half-cell fallback all
read the same PNG, so no generated Python portrait data needs to be rebuilt.

## Installation

On Windows, run the per-user installer from the repository root. It creates an
isolated Python runtime under `%LOCALAPPDATA%\Programs\Cleo`, stores
configuration, sessions, memory, and workspace data under
`%LOCALAPPDATA%\Cleo`, and places the standalone `cleo` launcher first in the
user `PATH`. Browser control also installs a pinned `agent-browser` release via
npm, so Node.js and npm are required during installation. The installer also
reads `memory_gate.model` from the destination `config/cleo.json`, downloads it,
and performs an embedding warm-up, so initial installation needs Hugging Face access:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

To migrate local configuration and runtime data from the current checkout,
copying only files that are missing at the destination:

```powershell
.\scripts\install.ps1 -MigrateCurrentData
```

Afterward, run `cleo` from a new terminal. The standalone launcher takes
precedence even when an editable or source installation is also present.
Update or uninstall with:

```powershell
.\scripts\update.ps1
.\scripts\uninstall.ps1
```

Uninstalling preserves `%LOCALAPPDATA%\Cleo` by default. Use
`.\scripts\uninstall.ps1 -PurgeData` only when you explicitly want to
permanently remove all local Cleo configuration, sessions, and memory. Codex
authentication and task history remain in the Codex-managed user directory and
are not copied into Cleo's data directory.

For source development, Python 3.12 or newer is recommended.

```bash
pip install -e .
```

Development dependencies:

```bash
pip install -e ".[dev]"
```

Source checkouts also need the browser runtime:

```bash
npm install -g agent-browser@0.33.1
```

`agent-browser` prefers an installed Chrome or Edge. If neither is available,
run `agent-browser install` to download Chrome for Testing. Pass
`-SkipBrowserInstall` to the Windows install or update script to install Cleo
without browser control. The Cleo uninstaller leaves the global
`agent-browser` package in place because other applications may use it.

The model is downloaded during installation or update and reused from the
Hugging Face user cache at runtime. Pass `-SkipMemoryModelDownload` to finish the
rest of an offline installation; the first gate run may then download it, and an
unavailable model fails open to DreamAgent.

`pyproject.toml` is the only manually maintained source for direct dependencies.
`requirements.txt` is the exact Linux container lock file and should not be edited
manually.

## Dependency Updates and Docker

Docker does not replace dependency manifests: `pyproject.toml` describes project
dependencies, `requirements.txt` locks resolved versions, and Docker installs that
lock file to produce a repeatable runtime. The image build also caches the default
Sentence Transformer. Override it with `--build-arg CLEO_MEMORY_GATE_MODEL=<model>`
or explicitly skip it with `--build-arg CLEO_SKIP_MEMORY_MODEL_DOWNLOAD=1`.

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

If Docker Desktop is temporarily unavailable but local `uv` is installed,
resolve the lock for the Python 3.12/Linux target with:

```bash
python scripts/update_project.py --local-resolver --skip-build
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
cmd /c "docker run --rm <image> --print-harnesses-template > harnesses.json"
notepad cleo.json
```

After filling in model settings and an API key, run:

```powershell
docker run --rm -it `
  --mount "type=bind,source=$($PWD.Path)\cleo.json,target=/config/cleo.json,readonly" `
  --mount "type=bind,source=$($PWD.Path)\harnesses.json,target=/config/harnesses.json,readonly" `
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
Productivity harnesses use `config/harnesses.json`; containers can select its
path with `CLEO_HARNESSES_CONFIG_PATH`.

Before the first run, you can copy the template manually:

```bash
copy cleo\config\templates\cleo.example.json config\cleo.json
copy cleo\config\templates\harnesses.example.json config\harnesses.json
```

You can also run Cleo directly. If `config/cleo.json` is missing, Cleo creates a
default template and asks you to fill in real profile settings.

`config/cleo.json` stores multiple profile registries in one JSON file:

```json
{
	"active_profiles": {
		"agent": "moonshot_openai_compatible",
		"dream_agent": "moonshot_openai_compatible",
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
				"persona_path": "PERSONA.md",
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
				"tavily_api_key": null,
				"codex_model": "gpt-5.5",
				"browser": {
					"enabled": true,
					"command": "agent-browser",
					"headless": true,
					"allow_private_network": false,
					"allowed_domains": [],
					"timeout_seconds": 45,
					"operation_timeout_ms": 25000,
					"idle_timeout_seconds": 900,
					"max_output_chars": 12000
				}
			}
		}
	}
}
```

`active_profiles` stores the selected profile names. `profiles` stores all
available profile definitions. `agent` selects the foreground Cleo profile,
while `dream_agent` independently selects a profile from `profiles.agents` for
background consolidation. Legacy configurations that omit `dream_agent` fall
back to `agent`. Pydantic validates the JSON, and the runtime code uses
`settings.active_agent_profile`, `settings.active_dream_agent_profile`,
`settings.active_directory_profile`, `settings.active_shell_profile`, and
`settings.active_tools_profile` to access the active configuration.

`profiles.tools.<name>.browser` controls Cleo's dedicated browser adapter.
Each Cleo thread gets a separate `agent-browser` session. Screenshots and full
versions of truncated results are written under
`data/session_artifacts/browser/`. Explicit open and new-tab targets allow
public HTTP(S) addresses by default, while localhost, private networks,
link-local addresses, and cloud metadata addresses are blocked. Set
`allow_private_network: true` only when testing a trusted local site;
production profiles can use `allowed_domains` to restrict navigation further.

`memory_gate` lazily loads a local Sentence Transformer before DreamAgent. It
skips only when every user turn is clearly closer to transient-conversation
prototypes. Ambiguous scores, missing packages, and model download failures fail
open to DreamAgent. Standard installation and Docker builds prefetch the model;
only skipped-prefetch or direct-source setups download it on first use. A skipped
source records `processed_hash` without claiming that its
content was written to project memory through `consolidated_hash`. See
`cleo/config/templates/cleo.example.json` for all parameters.

Productivity harnesses are registered from the separate
`config/harnesses.json`. `default_provider` selects the harness used when
`--provider` is omitted. Each key under `providers` becomes the provider name
stored in session metadata. Every provider shares the `type`, `enabled`, and
`model` envelope, while native differences stay under `options`. For example:

```json
{
	"default_provider": "codex",
	"providers": {
		"codex": {
			"type": "codex_sdk",
			"enabled": true,
			"model": "gpt-5.5",
			"options": {
				"approval_mode": "deny_all",
				"sandbox": "workspace-write"
			}
		}
	}
}
```

`--model` can still override the configured model for the selected provider.
`profiles.tools.codex_model` remains specific to the `codex` tool in Cleo's
main chat and is no longer the generic productivity model fallback.

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

- `/quit` or `/exit`: close Textual immediately, clear the view, and return
  control to the shell. Completed turns are already persisted, and only a
  session with user messages starts detached DreamAgent work after the UI exits.
- `/new`: complete the current session and start a new thread.
- `/project`: open the Cleo memory-project picker; click an existing project or create one by name.
- `/project <name>`: create or switch a Cleo project and start a thread in that memory scope.
- `/project move <name>`: move the current unconsolidated thread and its context to a project.
- `/rename <title>`: rename the current Cleo thread.
- `/resume <session-id>`: resume a saved Cleo thread; `/sessions` also supports click-to-resume.
- `/productivity`: open Codex productivity mode; use `/back` or `/quit` there to return.
- `/sessions`: open the Cleo conversation picker; productivity has its own code-session picker.
- `/attach`: attach an image file to the next message.

Type `/` to use command suggestions. Common actions are also available as
clickable buttons in the sidebar.

A thread title is generated from its first user message. Use `/rename` for a
Cleo thread; productivity mode continues to synchronize title changes through
the harness `/rename` capability. Titles are metadata, so renaming does not
trigger compaction or DreamAgent.

Cleo's status bar shows the active model and context window. It uses the active
agent profile's `max_tokens` as the configured limit and shows actual usage when
the compatible service returns usage metadata. Productivity prioritizes the
remaining Codex five-hour and weekly allowances plus reset times; it falls back
to context usage until the SDK returns limits and says `waiting` instead of
inventing data. Its sidebar shows reasoning effort, filesystem access, approval
behavior, and the current Git branch and dirty count.

Interactive mode also accepts `cleo --project <name>`. A Cleo project is a
logical memory boundary and does not need to match a code repository; keep using
the default `general` project when no separation is useful. `/new` keeps the
same project binding. `--resume` restores the space/project stored in the
manifest and rejects a conflicting `--project` argument.

Use `/project move <name>` to move an active thread while preserving its
context. A thread that DreamAgent has already consolidated cannot be moved
directly because durable knowledge may already exist in the original project;
switch projects and start a new thread instead.

The recommended interactive entry is `/productivity` from the main chat. Codex
productivity mode can also be started directly from the command line:

```bash
# Continuous interaction; the workspace directory is the productivity project
python main.py --productivity --cwd .

# One-shot task
python main.py --productivity --cwd . "Inspect the current changes and run tests"

# Resume the Codex native session associated with a Cleo session id
python main.py --productivity --resume agent_xxx
```

Use `--model` to override the model configured for the harness. Productivity
mode supports:

- `/project`: treat a project like Codex does—as a workspace directory. Click a
  recent directory or enter any existing directory. Cleo memory projects are
  not mixed into this list; `/cwd` and `/git` inspect the current directory and
  read-only Git status.
- `/cd <directory>`: change directory and create a new harness session; relative
  paths are resolved from the current `cwd`.
- `/resume <agent-id>`: restore a saved productivity session, its native harness
  context, and its historical transcript.
- `/sessions`: merge Cleo-managed sessions with unmanaged Codex native threads.
  Clicking either reads native Codex turns (falling back to Cleo's event log),
  restores the transcript, and reconnects the same native thread for continued
  conversation. A pure native thread receives a Cleo-managed mapping on first resume.
- `/native <native-id>`: browse native Codex history without importing it into
  Cleo memory.
- `/resume-native <native-id>`: restore native history, attach the thread to
  Cleo, and continue from its original context.
- `/model`, `/effort`, `/access`, and `/approval`: inspect or change the next
  Codex turn's runtime options.
- `/fork`, `/rename <name>`, `/compact`, and `/archive`: manage the native thread lifecycle.
- `/account`: show the current Codex account state.
- `/new`, `/back`, `/quit`, and `/exit`: manage the session or leave the view.

Codex SDK message, tool, terminal, plan, and file-change events stream to the
console and are normalized into the `productivity` space. Interactive views live
in `cleo/cli/chat_tui.py` and `cleo/cli/productivity_tui.py`; compact one-shot
output remains in `cleo/cli/console.py`. They stay separate from runtime, memory,
session aggregation, and provider implementations. Codex-specific controls remain in the Codex provider;
the generic adapter keeps the create/resume/prompt/cancel/close data plane.

## Runtime Files

These files are maintained by the code at runtime:

- `data/runtime.json`: current space/project/thread and space-partitioned recent threads.
- `data/shell_audit.log`: local shell tool audit log.
- `memory/sessions.sqlite3`: global rebuildable session metadata registry.
- `memory/persona.sqlite3`: cross-project persona traits and private event evidence.
- `memory/<space>/projects/<project>/sessions/<session>/manifest.json`: current session projection.
- `memory/<space>/projects/<project>/sessions/<session>/events.jsonl`: append-only evidence.
- `memory/<space>/projects/<project>/sessions/<session>/compact.json`: redacted compact projection.
- `PERSONA.md`: the descriptive global persona projection automatically loaded by foreground Cleo.
- `memory/<space>/memory.sqlite3`: durable memory, event evidence, and conversation chunks.
- `memory/<space>/memory_state.json`: source versions, processed/consolidated hashes, gate results, Dream status, and failures.
- `memory/<space>/projects/<project>/MEMORY.md`: DreamAgent-generated long-term memory.

`Runtime` stores only current CLI state. Append-only event logs are authoritative
interaction history, while manifests hold current metadata. Compact files,
SQLite indexes, and project `MEMORY.md` files are rebuildable. See
[`docs/CASTMIND_MEMORY_MIGRATION.md`](docs/CASTMIND_MEMORY_MIGRATION.md) for the
migration review and tradeoffs.

## Current Limits

- Native history currently loads the latest 50 threads; cursor pagination and
  advanced filters are not exposed in the CLI yet.
- Current resume is session message event replay, not a full durable LangGraph checkpoint.
- Historical retrieval currently uses local lexical ranking; uncalibrated vector retrieval is not enabled.
- `skills/` currently contains `demo-production` and `agent-browser`.
