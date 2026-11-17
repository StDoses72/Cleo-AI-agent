# Cleo Product Architecture

[中文](ARCHITECTURE.md) | [Documentation](README.en.md)

This document is for integrators and contributors. It describes Cleo's implemented product boundaries, runtime, harness adapters, session storage, and memory pipeline. After reading it, you should be able to identify which entry point owns a request, where its data is written, how providers extend the system, and which projections can be rebuilt safely.

Cleo is designed around local data control, a consistent experience across agents, resumable sessions, and evidence-backed long-term memory. Planned capabilities are not presented as shipped behavior. The design process and migration steps of the backend refactor are in [backend architecture v2](refactor/BACKEND_ARCHITECTURE_V2.md) (Chinese); the reasons behind individual decisions are in the [ADR index](adr/README.md) (Chinese).

## Product Context

```text
User
 ├── Cleo Desktop ── Electron/React ── JSONL IPC ─┐
 └── MCP client ── stdio ─────────────────────────┤
                                                   ▼
                                         Python application core
                                           ├── Cleo Chat → LLM API / subscription runtime
                                           └── Productivity → external harness
                                                   │
                                                   ▼
                                         local session + memory data
```

- The desktop app is the only graphical surface. The terminal CLI/TUI and the Docker runtime were removed in v0.8; the backend runs only as the desktop app's local service and as stdio MCP entry points. `tests/test_boundaries.py` keeps terminal UI code out of the backend.
- Cleo Chat uses a configured chat model or an official subscription runtime. Productivity connects to Codex, Claude SDK, or ACP agents through adapters.
- Cleo does not provide hosted accounts, a remote database, or an HTTP service. External network traffic comes from user-selected model, search, browser, or harness providers.

## Component Boundaries

```text
Electron main ── JSONL over stdio ── cleo.desktop.server
                                          │ rpc.py method table
                                          ▼
                                    DesktopService
                                          │ turn hooks → RunSupervisor
                                          ▼
                                     AgentSystem
                          ┌───────────────┴────────────────┐
                built-in LangGraph chat agent     AgentAdapter ── Codex / Claude / ACP
                          └───────────────┬────────────────┘
                                          ▼
                                    SessionStore
                     manifest.json · events.jsonl · compact.json · sessions.sqlite3
                                          │
                                          ▼
                              DreamAgent / history retrieval
```

- `cleo/bootstrap/container.py`: the composition root. Entry points load the configuration here and assemble `ConfigService`, `SessionStore`, `Runtime` and `DesktopService` explicitly instead of relying on import-time globals.
- `cleo/config/`: settings models, loading, and packaged templates. `config/service.py` provides versioned configuration snapshots with hot reload; a run is bound to the snapshot it started with.
- `cleo/desktop/server.py`: the JSONL stdio protocol server used by the Electron main process. `desktop/rpc.py` is the explicit method table of that protocol; `tests/desktop/test_rpc_registry.py` checks it against the service and the Electron sources.
- `cleo/desktop/service.py`: the desktop use-case service (workspace, threads, turns, settings). Runs in progress are registered in `desktop/runs.py::RunSupervisor` (at most one per thread, with its steering, approvals and workspace claim); the steps around a turn are `TurnHook`s in `desktop/turn_hooks.py`; slash commands live in `desktop/commands.py`.
- `cleo/desktop/agent_system.py`: a session is bound to an agent system, not to one agent. The only system today is `SingleAgentSystem`: chat sessions run the built-in LangGraph agent in `desktop/chat_runtime.py`, development tasks run the selected harness.
- `cleo/desktop/projection.py`, `presenters.py`, `timeline.py`: project persisted state into the renderer contract; the timeline index is a rebuildable SQLite projection.
- `cleo/agents/cleo.py`: the foreground Cleo agent; `cleo/agents/dream.py`: the background memory-consolidation agent. Agent-callable tools live under `cleo/agents/tools/`.
- `cleo/harnesses/`: the provider-neutral harness API, capability declarations, control plane, approvals and questions, and the session adapter.
- `cleo/integrations/harnesses/`: Codex, Claude, and ACP providers plus their composition factory. The rest of `cleo/integrations/` covers native home resolution and migration, subscription runtimes, model catalogs, Git and workspaces.
- `cleo/sessions/`: `store.py` composes manifests (`manifests.py`), the append-only event log (`event_log.py`), the global index (`index.py`), the incremental compact cache (`compact.py`) and rewinds (`rewind.py`).
- `cleo/memory/`: compact projections, Markdown project preferences with their nested Git history, evidence, cross-source reading, paths, and consolidation state.
- `cleo/runtime/`: `state.py` stores UI navigation state; `usage.py` and `context_capacity.py` handle context readings; `task_*.py` keep the task usage ledger; `timing.py` measures replies.
- `cleo/routing/`: constrained subtask routing that never changes the coordinating session's model (see [subtask routing](benchmark-routing.md), Chinese).
- `cleo/computer/` and `cleo/integrations/computer.py`: the built-in browser and local computer control (see [computer use](computer-use.md), Chinese).
- `cleo/mcp/`: stdio MCP entry points: `codex_server`, `memory_server`, `agent_server` and `computer_server`.

Dependencies flow from `desktop` into `agents`, `harnesses`, `sessions`, `runtime`, and `integrations`. Session persistence may depend on memory projections, but sessions, memory and integrations do not depend back on the desktop entry point, and provider SDK types do not leak into `SessionStore` or the renderer.

## Domain, Application, And Infrastructure

Feature packages remain in place; individual modules have distinct responsibilities:

| Layer | Modules | Responsibility |
| --- | --- | --- |
| Domain / contracts | `harnesses/{models,control,provider,capabilities}.py`, `sessions/{ports,policy}.py` | Session/event types, provider and repository contracts, capability declarations, pure content rules |
| Application | `harnesses/service.py::AgentService`, `desktop/service.py::DesktopService`, `desktop/runs.py` | Coordinate session creation, resume, turns, cancellation and close; the run lifecycle |
| Infrastructure | `integrations/harnesses/`, `sessions/store.py`, `integrations/{background,workspace}.py` | SDKs, JSONL/SQLite, detached processes, filesystem and Git |
| Presentation | `desktop/projection.py`, `desktop/presenters.py`, `ui/src/components/` | Desktop rendering |
| Composition / compatibility | `bootstrap/container.py`, `harnesses/adapter.py`, `integrations/harnesses/factory.py` | Construct and connect concrete implementations |

`AgentService` depends on `AgentProvider` and `SessionRepository` protocols. Python protocols are structural interfaces: implementations supply the declared methods without inheriting a framework base class. The repository port contains only persistence operations used by harness orchestration; paths, database connections and projection storage stay with `SessionStore`. A provider declares its optional capabilities on its class (`harnesses/capabilities.py`); no provider has to implement Codex-only features.

The `AgentAdapter(project_root, ...)` constructor supplies local storage defaults and retains `register_acp`. New use-case logic belongs in `AgentService`, and provider construction belongs in the factory. Directory validation remains an application input boundary.

Shared payload and usage projections live in `harnesses/events.py`; process and workspace operations live in `integrations/`. The renderer composition point explicitly returns the `CleoClient` interface implemented by IPC and mock clients.

Agent graph construction, memory persistence and runtime JSON storage are concrete implementations; the entire Python package is not a pure domain layer.

## Installation And Runtime Paths

In a source checkout, when `cleo/config/settings.py` can see `pyproject.toml` at the source root, relative paths are rooted at the repository.

Desktop packages use a split layout (Windows shown; see [platforms](PLATFORMS.en.md) for the others):

```text
%LOCALAPPDATA%\Programs\Cleo\   # Electron app and launcher
%LOCALAPPDATA%\Cleo\            # config, data, memory, skills, workspace, runtimes
%USERPROFILE%\.codex\           # Codex native home: login, configuration, sessions, skills
%USERPROFILE%\.claude\          # Claude native home
```

The Electron main process sets `CLEO_HOME` explicitly and copies only missing files from packaged defaults. Codex and Claude use the machine's native homes (`CODEX_HOME` / `CLAUDE_CONFIG_DIR` take precedence) and share login and history with the native clients; the migration rules for retired Cleo-specific homes are in [configuration](CONFIGURATION.en.md).

Downloading, switching, rolling back and the fallback entry of program versions are handled by `ProgramUpdates` / `ProgramVersions` on the Electron side. They replace only a SHA-256-verified program and never overwrite user data (see [program versions and recovery](program-versions.en.md)). Uninstalling preserves the data directory by default. Source checkouts and desktop packages do not depend on each other's data directories.

## Space And Project

Every session is bound by:

```text
space + project + session_id
```

The implemented spaces are:

- `non_productivity`: Cleo chat, personal context, preferences, and general plans.
- `productivity`: engineering work performed by Codex, Claude, or ACP harnesses.

The same project name in two spaces still represents separate data. SQLite queries, compact validation, DreamAgent tools, and evidence all require the space to prevent productivity records from silently entering personal memory. Reading across spaces happens only through explicit retrieval tools (see [bidirectional memory reading](MEMORY_READING.md), Chinese).

A project in chat is an optional logical memory boundary for a long-running topic, plan, or workflow; it does not require a code directory, and chats without a project are recorded under `general`. A development task instead treats normalized `cwd` as the user-visible project identity. The internal session `project` field still partitions Cleo-owned records and defaults to the folder name; the harness code boundary always comes from `cwd` or the repository.

A Cleo thread title is derived from its first `user_message` and can be changed as metadata. An active, unconsolidated thread can move between projects; its session directory, manifest, event bindings, SQLite registry, compact view, memory state, and conversation chunks move together. Once DreamAgent has consolidated the source, migration is rejected because durable knowledge in the old project cannot be retracted reliably. The desktop exposes this through the `move_thread` RPC and the conversation menu's "Move to project…" dialog, and `/project move <name>` works for chat and development tasks alike. Running threads, cross-space targets, and tasks that carry a harness handoff snapshot are rejected with a stated reason. After a development task moves, its `cwd` points at the target project directory, the resident harness session is closed and resumed in the new directory on the next turn, and the previous turn's Git undo checkpoint is discarded ([ADR 0002](adr/0002-move-conversation-into-project.md)).

## Session Storage

```text
memory/
├── MEMORY_POLICY.md
├── sessions.sqlite3
├── non_productivity/
│   ├── memory.sqlite3
│   ├── memory_state.json
│   └── projects/<project>/
│       ├── MEMORY.md
│       └── sessions/<session_id>/
│           ├── manifest.json
│           ├── events.jsonl
│           └── compact.json
└── productivity/
    ├── memory.sqlite3
    ├── memory_state.json
    └── projects/<project>/
        ├── MEMORY.md
        └── sessions/<session_id>/
            ├── manifest.json
            ├── events.jsonl
            └── compact.json
```

`manifest.json` is an atomically replaced projection of title, provider, native session ID, current status, cwd, event sequence, source hash and update time. `events.jsonl` is the authoritative append-only record: each line carries a global event ID, a strictly increasing sequence number, its space/project/session binding, actor, type, time and payload. Completed semantic messages are persisted rather than individual streaming token deltas. Large outputs go to `data/session_artifacts/`, and the event stores a reference.

Editing an earlier user message never rewrites the log. Cleo appends a `rewind` event whose `data.turn_id` names the edited turn. The timeline, chat history restore, harness handoff context, and memory compaction skip every event from that turn up to the `rewind` marker, while sequence numbers and source hashes still cover the full log.

`compact.json` merges tool calls and results, redacts secrets, omits low-value bulk output, and records source event IDs, source hash, and sequence range. The file uses v3 immutable batches followed by a replaceable footer, so each turn appends only new records. Loading validates range, sequence and file version; a bounded validation record is reused for an unchanged file, and the full events are read and hashed on first use, change or damage.

`memory/sessions.sqlite3` is a rebuildable global metadata registry. Each space has its own `memory.sqlite3` containing atomic memory, event evidence, consolidation records, and lexical conversation chunks. The `.desktop-timeline-v1.sqlite3` file in a session directory is the rebuildable index of the desktop timeline. SQLite is not the raw conversation source of truth.

Loading the workspace does not grow with history: indexes read only appended events, and a projection version is raised only when an old index is wrong ([ADR 0010](adr/0010-startup-cost-independent-of-history.md)).

Persona storage has left the runtime path. Existing `persona.sqlite3` and `PERSONA.md` remain untouched; they are not read, injected, updated, or converted into project preferences, and a legacy `persona_path` setting is ignored during validation.

## Desktop Turn Flow

```text
renderer stream_turn
  → rpc.py method table → DesktopService.stream_turn
  → TurnHook.check (reject an invalid turn)
  → RunSupervisor registers the run and binds the configuration snapshot
  → TurnHook.prepare (/computeruse and local skills rewrite the prompt)
  → AgentSystem.run_turn → AgentRuntime.stream
  → canonical event → SessionStore appends events.jsonl
  → projection → emit back to the renderer
```

Messages typed while a run is in progress are queued and can be delivered into the running turn with `steer_run` (`desktop/steering.py`); `cancel_run`, `resolve_approval` and `resolve_question` act on the registered run.

## Harness Event Adaptation

Provider-native output is translated before storage:

```text
native provider event
    → provider-specific translator
    → Cleo canonical event
    → SessionStore
```

Canonical semantics include assistant messages, tool calls and results, permission requests and responses, question requests and responses, file changes, terminal output, plan updates, status, and errors. Events that cannot be normalized safely become `provider_event` records with provider identity, native event type, and a sanitized payload in `data`. SessionStore does not depend on any harness's SDK types.

A native result does not necessarily end a turn. Claude Code can keep running background tasks (`Bash(run_in_background=true)`, background agents) after the foreground turn ends and, when they finish, wakes the model on the same stream for another round. `ClaudeProvider.prompt` decides that the turn is really over from the set of background tasks plus a count of wake-ups still owed after each `task_notification`: stage boundaries are recorded as the `status` event `claude/stage_completed`, a wait timeout or cancellation writes `claude/background_abandoned` and ends with a `failed` / `cancelled` terminal status, and tasks marked `ambient: true` never belong to the current turn. The service, projections, and UI do not need to know these harness-specific semantics. The native question, approval, turn-end, and background-task protocols of each harness and how Cleo adapts them are documented in [Harness questions and turn lifecycle](harness/interactive-lifecycle.md) (Chinese) and [ADR 0004](adr/0004-claude-turn-and-background-task-lifecycle.md).

## Cleo Chat Flow

```text
user message
  → Agent.stream_text
  → LangGraph state
  → synchronize newly completed messages
  → append events.jsonl
  → atomically update manifest
  → incrementally update compact.json
  → update space-bound history chunks
```

Resuming a chat uses the global registry to locate the manifest, then reconstructs LangChain messages from message events. This is not durable LangGraph checkpoint recovery.

A chat on a subscription connection is executed by the official runtime (`cleo/agents/runtime.py`, `cleo/integrations/subscriptions.py`); credentials stay in each vendor's own login store. See [subscription connections and DreamAgent](SUBSCRIPTION_CHAT.md) (Chinese).

## Harness Flow

```text
AgentAdapter.create_session
  → provider creates native session
  → productivity manifest + session_created

AgentAdapter.prompt
  → user_message + session_running
  → provider prompt
  → translate provider events
  → assistant_message + terminal status
  → compact projection + SQLite index

Codex rich control plane
  → thread/list + thread/read (browse native history)
  → model/list + account/read (capability discovery)
  → per-turn model / effort / sandbox / approval
  → thread/fork / name/set / compact / archive

AgentAdapter.rewind (editing an earlier user message)
  → Codex: thread/revert drops that turn and every later turn
  → Claude: fork the native transcript offline before that message and switch to it
  → rewind event + a new turn with the edited text
```

Each `session_<status>` event records the turn's native ID so a Codex edit can target it directly; otherwise native turns are matched to prompts from newest to oldest. Only turns after the latest harness handoff can be edited, and ACP tasks do not offer editing. Editing rewinds the conversation only; files already written to the workspace are not reverted.

The provider factory reads the separate `config/harnesses.json`, registers enabled Codex SDK, Claude SDK, or ACP providers, and selects the configured default. A development task can be created or can resume a native session through a Cleo session ID. Slash commands typed into the composer (`/cwd`, `/cd`, `/model`, `/effort`, `/resume`, `/native`, `/resume-native`, `/fork`, `/compact` and others) are handled in `desktop/commands.py`: `/native` browses a native transcript without writing it into Cleo's event log, and `/resume-native` is the explicit boundary that creates or reuses a Cleo handle to native-thread mapping.

Each managed productivity thread stores its provider/harness on the manifest and its model, reasoning effort, sandbox, and approval behavior in `runtime_options`. When a native session is resumed, `AgentAdapter` reapplies those values to the provider runtime; the saved settings change only after an explicit user update. A harness switch takes effect with the next message; its handoff context is produced and validated by `harnesses/context.py` and `handoff.py`.

Every harness's context reading is normalized as a `status` event: Codex `thread/tokenUsage/updated`, ACP `usage_update`, and the `cleo/context_usage` event the Claude provider publishes for each request. `cleo/harnesses/events.py` projects them with one definition: occupancy is the input the latest request put in the window (new input, cache reads and cache writes), without output, over the window the harness reports. It drives the ring beside the send button. Account usage (`get_harness_usage`) is read on demand when the user opens the ring's panel: Codex through `account/rateLimits/read`, Claude through the CLI's `get_usage` control request. A reading is reused for 60 seconds, and a value that cannot be read is not shown. See [ADR 0011](adr/0011-one-context-measure-and-on-demand-account-usage.md).

The generic `AgentAdapter` data plane remains limited to create/resume/prompt/cancel/close. Codex history, models, and thread lifecycle are optional control-plane capabilities, so Claude and ACP providers do not need to pretend they expose the same native operations. Completed content remains in SessionStore after provider connections close.

## DreamAgent Flow

```text
raw events.jsonl → bounded projection with source references and omission markers
  → current project preferences + user evidence → old/new candidate edits
  → skip individual conflicts that lack evidence, keep the other valid edits
  → re-check against the latest text → atomically publish MEMORY.md and commit to Git
  → advance committed_seq and clear pending once publication is durable
```

Both spaces extract only project preferences backed by user evidence. Facts, code and task results are found through history retrieval. A project's `MEMORY.md` is the only place preference text is stored, and its changes are recorded in a nested Git repository (see [Markdown memory and migration](MEMORY_MARKDOWN_GIT.md), Chinese).

DreamAgent independently selects a model profile from `profiles.agents` through `active_profiles.dream_agent`. Legacy configurations fall back to the foreground `active_profiles.agent` selection when this field is absent.

Background consolidation runs inside the desktop process as one sequential, cancellable batch (`desktop/background_memory.py`), triggered by elapsed time or by the number of pending sources. It is off by default, and manual consolidation remains available while it is off. A failed source retries automatically with bounded backoff and can be retried from the queue ([ADR 0001](adr/0001-retry-failed-memory-sources.md)). Automatic consolidation never edits `AGENTS.md` and never creates or updates a skill. The consolidation switch is independent of read-only memory queries and of staying in the tray; turning it off stops new model calls, and cancellation and restart resume from the existing pending/checkpoint state.

After the user confirms consolidation, DreamAgent processes the validated compact directly. Manual skip records `processed_hash` and a skipped state. `consolidated_hash` remains reserved for a source that completed the project-memory protocol, so manually skipped threads remain movable under the unconsolidated-thread rule.

## Runtime State

`data/runtime.json` only stores UI state: the interface language, the active space, project and thread, and space-partitioned project/recent-thread lists. It contains no transcript and is not the session registry.

## Extension Points

### Adding a Productivity provider

Implement the `AgentProvider` create/resume/prompt/cancel/close contract, translate native output into canonical events inside the provider, declare its capabilities on the provider class, and register its configuration through the factory. Only capabilities shared by every provider belong in `AgentAdapter`; history, model enumeration, and thread operations remain optional control-plane features.

### Adding a desktop protocol method

Implement a method of the same name on `DesktopService` and list it with its caller in the method table in `desktop/rpc.py`; a method the renderer may call must also enter the allowlist in `ui/electron/main.mjs`. The protocol must define streaming events, cancellation, errors, shutdown, and secret-safe DTOs.

### Adding a memory projection

Projections must be derived from a validated compact view or the authoritative event log and bound to space/project/session plus source hash. A projection failure must never rewrite or damage the raw event log.

## Current Deployment Boundaries

- Desktop packages target Windows x64, macOS Apple Silicon / Intel and Linux x64; there are no native Linux ARM64 or Windows ARM64 packages.
- The application follows a local single-user model and has no multi-tenant identity, remote sync, or server-side authorization layer.
- `events.jsonl` assumes one append writer per session; external tools must not edit live runtime files concurrently.
- Provider capabilities differ. UI features must degrade by capability rather than assume every harness behaves like Codex.
- Automatic memory is auditable supporting context, not a replacement for raw sessions or user confirmation.

See [configuration](CONFIGURATION.en.md) for deployment and security defaults. The development guide is maintained in Chinese: [development and releases](DEVELOPMENT.md).
