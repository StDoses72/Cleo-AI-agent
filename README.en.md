# Cleo AI Agent

[中文](README.md) | [Documentation](docs/README.md) | [Architecture](docs/ARCHITECTURE.en.md)

Cleo is a local-first AI workspace that brings general chat, developer agents, resumable sessions, and evidence-backed memory into one desktop and CLI experience. Teams can supply their own models, tools, harnesses, and data boundaries.

The project currently ships a Windows desktop app, a Python CLI, Textual TUIs, and a stdio MCP entry point. User data stays on the local device by default; inference is provided by the API provider or external agent harness selected by the user.

> Current version: `0.1.6`. Cleo is still pre-1.0 and is best suited to evaluation, internal-tool integration, and active development. Pin a version and validate it before deployments that require stable data formats or extension contracts.

## What Cleo solves

General assistants and coding agents usually keep separate histories, permissions, and project context. Cleo adds a consistent product layer across them:

- **One workspace** for general chat and Productivity development workflows.
- **Resumable sessions** with normalized provider events, projects, titles, history, and recovery.
- **Scoped memory** partitioned by `space + project + session`, with evidence for durable conclusions.
- **Replaceable models and harnesses** for foreground Cleo, DreamAgent, Codex, Claude SDK, and ACP agents.
- **Local auditability** for configuration, sessions, tool logs, and memory without a Cleo-hosted account service.

## Product surfaces

| Surface | Audience | Primary use |
| --- | --- | --- |
| Cleo Desktop | End users and developers | Conversation and project management, chat, Productivity, memory inspection, model settings, and updates |
| Cleo Chat CLI / TUI | Terminal users | One-shot prompts, continuous chat, image attachments, project memory, and session resume |
| Productivity TUI | Software developers | Run Codex, Claude SDK, or ACP agents in a selected working directory |
| `cleo-codex-mcp` | Integrators | Expose `codex` and `codex-reply` over stdio MCP |

## Highlights

- Streaming chat and one-shot tasks with JPEG, PNG, WebP, and GIF attachments.
- A provider-neutral coding-harness data plane plus optional Codex-specific controls.
- An append-only `events.jsonl` source of truth, atomic manifests, and rebuildable SQLite indexes.
- Separate `non_productivity` and `productivity` memory spaces.
- Deterministic compaction, secret redaction, a local Sentence Transformer gate, and DreamAgent consolidation.
- Project-scoped long-term memory, history retrieval, and a global persona limited to interaction tendencies.
- Local shell controls for allowlists, path boundaries, timeouts, output limits, and audit logging.
- Per-thread browser sessions with public/private-network and domain boundaries.
- A self-contained Windows package with SHA-256 verified updates and data-preserving uninstall behavior.

## Start in five minutes

### Windows desktop

Download `Cleo-windows-x64.zip` from [GitHub Releases](https://github.com/StDoses72/Cleo-AI-agent/releases), or run the verified installer from a source checkout:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\download.ps1 -Launch
```

Program files are installed under `%LOCALAPPDATA%\Programs\Cleo`. Configuration, sessions, memory, and model caches live under `%LOCALAPPDATA%\Cleo`; updates replace the program directory without overwriting user data.

On first launch, open **Settings → Models**, configure a provider, model, API key, and optional base URL, then select profiles for Cleo and DreamAgent. API keys are written only to local configuration and are never returned in plaintext by the desktop read API.

### Run from source

Python 3.12+ is required. Node.js and `agent-browser` are needed for browser tools.

```powershell
git clone https://github.com/StDoses72/Cleo-AI-agent.git
Set-Location Cleo-AI-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
npm install -g agent-browser@0.33.1
Copy-Item cleo\config\templates\cleo.example.json config\cleo.json
Copy-Item cleo\config\templates\harnesses.example.json config\harnesses.json
```

Add at least one working agent profile to `config/cleo.json`, then run:

```powershell
cleo
cleo "Summarize this repository's architecture."
cleo --productivity --cwd .
```

Linux and macOS source runs use the same Python package and JSON formats. The prebuilt desktop package and installer currently support Windows only.

## Common workflows

```powershell
# Continuous general chat
cleo

# Bind chat and memory to a logical project
cleo --project product-planning

# One-shot task
cleo "Turn these requirements into acceptance criteria."

# Start the default coding harness in the current directory
cleo --productivity --cwd .

# Select a registered provider and model
cleo --productivity --provider codex --model gpt-5.5 --cwd .

# Resume a Cleo-managed session
cleo --resume <session-id>
cleo --productivity --resume <session-id>
```

The chat UI supports `/help`, `/new`, `/project`, `/sessions`, `/resume`, `/rename`, `/attach`, and `/productivity`. Productivity also exposes `/cwd`, `/cd`, `/git`, `/diff`, `/model`, `/effort`, `/access`, `/approval`, `/native`, and `/resume-native`; commands vary with provider capabilities.

## Architecture at a glance

```text
Desktop / CLI / TUI / MCP
            │
            ├── Cleo Chat ─────── Deep Agents + configured LLM
            │
            └── Productivity ──── AgentAdapter ─── Codex / Claude / ACP
                                      │
                                      ▼
                SessionStore: manifest + append-only event log
                                      │
                       compact projection + local indexes
                                      │
                     memory gate → DreamAgent consolidation
                                      │
                    project memory + evidence + persona
```

Four rules define the system:

1. `events.jsonl` is the session source of truth; manifests, compact views, SQLite, and Markdown are projections.
2. Every session and memory record belongs to `space + project + session_id`.
3. Provider-native output is translated into canonical Cleo events before storage.
4. Automatic memory never edits `AGENTS.md`, grants permissions, or creates skills.

See the [architecture guide](docs/ARCHITECTURE.en.md) for component and data-flow details.

## Data, privacy, and security boundaries

Local-first does not mean fully offline:

- Configuration, sessions, memory, runtime state, and tool audits are stored locally by default.
- Prompts, attachments, and tool context are sent to the selected model or harness provider and remain subject to that service's policies.
- Browser tools can access the network; localhost, private networks, link-local addresses, and cloud metadata endpoints are denied by default.
- Shell and coding harnesses can run commands or modify files according to `cleo.json`, `harnesses.json`, and provider sandbox/approval settings.
- `config/cleo.json` contains API keys and must not be committed or shared.

Review [configuration and security boundaries](docs/CONFIGURATION.md) before deployment.

## Repository map

```text
Cleo-AI-agent/
├── cleo/                 # Python product core: agents, CLI, desktop service, sessions, memory, harnesses
├── ui/                   # Electron + React desktop client
├── config/               # Local configuration, ignored by default
├── docs/                 # User, architecture, development, and design-decision docs
├── memory/               # Memory policy and local runtime data
├── scripts/              # Dependency, release, download, uninstall, and cleanup scripts
├── skills/               # Local skills loadable by Cleo
├── tests/                # Tests organized by production responsibility
├── compose.yaml          # Local container entry point
└── pyproject.toml        # Python metadata and direct dependencies
```

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/GETTING_STARTED.md)
- [Configuration and security](docs/CONFIGURATION.md)
- [Architecture](docs/ARCHITECTURE.en.md)
- [Development and releases](docs/DEVELOPMENT.md)
- [Backend contributor guide](docs/BACKEND_CODE_REVIEW.md)
- [Runtime and data maintenance guide](docs/Cleo_Runtime_State_Maintenance_Guide.docx)
- [Memory-system design record](docs/CASTMIND_MEMORY_MIGRATION.md)

The deep operational guides are currently maintained in Chinese; the root README and architecture reference are bilingual.

## Development

```powershell
pip install -e ".[dev]"
ruff check cleo tests
pytest -q

Set-Location ui
npm install
npm run typecheck
npm run test:backend
npm run smoke
```

On Windows, run `npm run package:portable` from `ui/` to build the full release into the repository-level `release/` directory. See the [development guide](docs/DEVELOPMENT.md) and [desktop subsystem guide](ui/README.md).

## Current boundaries

- The prebuilt desktop application currently targets Windows x64; other platforms run from source.
- Cleo is a local single-user application and stdio tool, not a multi-tenant web service or HTTP API.
- General chat primarily targets OpenAI-compatible chat models; compatibility depends on provider behavior.
- Productivity providers do not expose identical capabilities; Claude and ACP do not emulate Codex-only controls.
- Long-term memory is automatically extracted and important conclusions should be checked against evidence and the raw event log.

## Contributing

Issues and pull requests are welcome. Before changing the code, read [AGENTS.md](AGENTS.md), the [development guide](docs/DEVELOPMENT.md), and the relevant tests. Changes to session, memory, or provider protocols should include focused regression tests and documentation updates.

Licensed under the [MIT License](LICENSE).
