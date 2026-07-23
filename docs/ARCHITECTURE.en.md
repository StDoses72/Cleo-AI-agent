# Current Cleo Architecture

This document describes the implemented runtime, harness adapters, session
storage, and memory pipeline. It does not present the future productivity UI or
a standalone SessionHub service as completed work.

## Component Boundaries

```text
Cleo CLI / Main Agent
        │
        ├── non_productivity session
        │
        ├── AgentAdapter ── Codex / Claude SDK
        │        │
        │        └───────── ACP harness
        │
        ▼
SessionStore
        ├── manifest.json
        ├── events.jsonl
        ├── compact.json
        └── sessions.sqlite3
                │
                ▼
        DreamAgent / Retrieval
```

- `cleo/agents/cleo.py`: the foreground Cleo agent; `cleo/agents/dream.py`: the
  background memory-consolidation agent. Agent-callable tools live under
  `cleo/agents/tools/`.
- `cleo/cli/application.py`: argument parsing and top-level dispatch only; the
  root `main.py` preserves the `python main.py` compatibility entry point.
- `cleo/cli/chat.py` and `cleo/cli/productivity.py`: the chat and harness flows.
- `cleo/cli/lifecycle.py`: session persistence and DreamAgent consolidation lifecycle.
- `cleo/cli/console.py`: Rich output, streamed events, Session Hub presentation,
  and `prompt_toolkit` input. Command completion and normalized harness event
  rendering live in `cleo/cli/completion.py` and
  `cleo/cli/productivity_renderer.py`.
- `cleo/images/`: replaceable PNG loading and automatic cropping, terminal-image
  selection, dynamic pixel fallback, and Sixel rendering.
- `cleo/sessions/store.py`: manifests, append-only events, and the global registry.
- `cleo/sessions/hub.py`: managed/native session aggregation with no CLI dependency.
- `cleo/memory/`: compact projections, durable memory, evidence, paths, and consolidation state.
- `cleo/runtime/state.py`: current CLI scope and recent sessions;
  `cleo/runtime/usage.py`: shared context-window usage.
- `cleo/harnesses/`: provider-neutral harness API, control plane, and session adapter.
- `cleo/integrations/harnesses/`: Codex, Claude, and ACP providers plus their composition factory.
- `cleo/integrations/git.py`: read-only Git status; `cleo/integrations/codex.py`:
  the backward-compatible Codex facade.
- `cleo/config/`: settings models, loading, and packaged templates; `cleo/mcp/`:
  the stdio MCP entry point.

Dependencies flow from `cli` into `agents`, `sessions`, `runtime`, and
`integrations`. Session persistence may depend on memory projections, while
session aggregation and Git integration do not depend back on the CLI. These
directory boundaries change source ownership only: the CLI still constructs the
same Agent, adapter, SessionStore, and Runtime through the same entry points,
configuration formats, and persistence protocols.

## Installation And Runtime Paths

A source checkout keeps the existing behavior: when `cleo/config/settings.py` can
see `pyproject.toml` at the source root, relative paths remain rooted at the
repository.

The Windows `scripts/install.ps1` uses a split layout:

```text
%LOCALAPPDATA%\Programs\Cleo\   # launcher and isolated Python runtime
%LOCALAPPDATA%\Cleo\            # config, data, memory, skills, workspace
%USERPROFILE%\.codex\           # Codex-managed authentication and task history
```

The launcher sets `CLEO_HOME` explicitly. Other packaged environments use the
`platformdirs` user data directory when `CLEO_HOME` is absent. Docker sets
`CLEO_HOME=/app` and continues to persist runtime data through volumes.
Updating does not overwrite existing configuration or user data, and
uninstalling preserves the data directory by default. Standalone installs
prefer `%LOCALAPPDATA%\Cleo\assets\startup.png` and fall back to the packaged
default when that file is absent.

## Space And Project

Every session is bound by:

```text
space + project + session_id
```

The implemented spaces are:

- `non_productivity`: Cleo chat, personal context, preferences, and general plans.
- `productivity`: engineering work performed by Codex, Claude, or ACP harnesses.

The same project name in two spaces still represents separate data. SQLite
queries, compact validation, DreamAgent tools, and evidence all require the
space to prevent productivity records from silently entering personal memory.

A project in Cleo chat is an optional logical memory boundary for a long-running
topic, plan, or workflow; it does not require a code directory, and `general`
is the default. In productivity, the project still partitions Cleo-owned
records while the harness code boundary comes from its `cwd` or repository.
External local projects may be associated by normalized `cwd`, but are not
forced into a one-to-one mapping with Cleo project names or internal IDs.

A Cleo thread title is derived from its first `user_message` and can be changed
as metadata. An active, unconsolidated thread can move between projects; its
session directory, manifest, event bindings, SQLite registry, compact view,
memory state, and conversation chunks move together. Once DreamAgent has
consolidated the source, migration is rejected because durable knowledge in the
old project cannot be retracted reliably.

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

`manifest.json` is an atomically replaced projection of title, current status,
and metadata. `events.jsonl` is the authoritative append-only record. Completed
semantic messages are persisted rather than individual streaming token deltas.

`compact.json` merges tool calls and results, redacts secrets, omits low-value
bulk output, and records source event IDs, source hash, and sequence range. A
compact projection is accepted only when its scope, hash, and final sequence
still match the raw event log.

`memory/sessions.sqlite3` is a rebuildable global metadata registry. Each space
has its own `memory.sqlite3` containing atomic memory, event evidence,
consolidation records, and lexical conversation chunks. SQLite is not the raw
conversation source of truth.

## Harness Event Adaptation

Provider-native output is translated before storage:

```text
native provider event
    → provider-specific translator
    → Cleo canonical event
    → SessionStore
```

Canonical semantics include assistant messages, tool calls and results,
permission requests, file changes, terminal output, plan updates, status, and
errors. Events that cannot be normalized safely become `provider_event` records
with provider identity, native event type, and a sanitized payload in `data`.

## Cleo Chat Flow

```text
user message
  → Agent.stream_text
  → LangGraph state
  → synchronize newly completed messages
  → append events.jsonl
  → atomically update manifest
  → rebuild compact.json
  → update space-bound history chunks
```

`--resume` and the main chat's `/resume` both use the global registry to locate
the manifest, then reconstruct LangChain messages from message events. This is
not durable LangGraph checkpoint recovery.

Cleo captures provider usage metadata from streamed `AIMessageChunk` objects. If
the provider omits it, the status bar shows only the configured limit and
`waiting`.

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
```

`/productivity` in the main chat is the interactive terminal entry point; leaving
it restores the prior Cleo space/project/thread. `main.py --productivity` remains
the direct and scriptable entry. Both use the provider factory to read the
separate `config/harnesses.json`, register enabled Codex SDK, Claude SDK, or ACP
providers, and select the configured default. The loader exposes the validated
result as `settings.productivity`. They can create or resume a native
session through a Cleo session ID and render SDK notifications as they arrive.
Productivity `/resume` uses the same restoration path; `/cwd` shows the working
directory and `/cd` creates a new session bound to the target directory. `--cwd`
controls the harness working directory; `--project` controls only Cleo's memory
scope.

Codex `thread/tokenUsage/updated` notifications are normalized as `status` events
and drive the CLI context bar using the SDK's `totalTokens` and
`modelContextWindow` values. A second status bar shows reasoning effort, sandbox,
approval behavior, and a read-only Git branch/dirty-count projection.

The generic `AgentAdapter` data plane remains limited to
create/resume/prompt/cancel/close. Codex history, models, and thread lifecycle are
optional control-plane capabilities, so Claude and ACP providers do not need to
pretend they expose the same native operations.

SessionHub merges Cleo-managed rows from `sessions.sqlite3` with live Codex
`thread/list` results. Attached threads appear as `cleo+native`; unmanaged Codex
threads appear as `native`. `/native` browses a native transcript without writing
it into Cleo's event log. `/resume-native` is the explicit boundary that creates
or reuses a Cleo handle to native-thread mapping. Completed content remains in
SessionStore after provider connections close.

## DreamAgent Flow

```text
validated compact
  → validate space/project/session/source hash
  → read project memory in the same scope
  → atomic memory + evidence_event_ids
  → atomically render MEMORY.md
  → explicitly complete consolidation
```

Non-productivity consolidation emphasizes user facts, preferences, goals, and
corrections. Productivity consolidation emphasizes task intent, technical
decisions, changed files, tests, errors, artifacts, and unfinished work.

Automatic consolidation never edits `AGENTS.md` and never creates or updates a
skill.

## Runtime State

`data/runtime.json` only stores the active CLI space, project, thread, and
space-partitioned project/recent-thread lists. It contains no transcript and is
not the session registry.
