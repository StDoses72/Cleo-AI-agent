# Current Cleo Architecture

This document describes the implemented runtime, harness adapters, session
storage, and memory pipeline. It does not present an unimplemented standalone
SessionHub service as completed work.

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
- `cleo/cli/chat.py` and `cleo/cli/productivity.py`: backend orchestration for
  chat and harness flows; `cleo/cli/chat_tui.py` and
  `cleo/cli/productivity_tui.py` provide the two full-screen Textual views.
- `cleo/cli/productivity_history.py`: normalizes Codex native turns or Cleo event
  logs into restored transcript cards. Native-thread resume remains independent
  from history rendering, so a display failure does not block continuation.
- `cleo/cli/lifecycle.py`: session persistence and DreamAgent consolidation lifecycle.
- `cleo/cli/console.py`: compact Rich output for one-shot commands. Shared
  harness event projection and non-interactive rendering live in
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

The Windows desktop download uses a split layout:

```text
%LOCALAPPDATA%\Programs\Cleo\   # Electron app and isolated Python/Node runtimes
%APPDATA%\Cleo\                 # config, data, memory, models, skills, workspace
%USERPROFILE%\.codex\           # Codex-managed authentication and task history
```

The Electron main process sets `CLEO_HOME` explicitly and copies only missing
files from packaged defaults. Downloads replace only a SHA256-verified program
directory and never overwrite user data. Docker sets
`CLEO_HOME=/app` and continues to persist runtime data through volumes.
Updating does not overwrite existing configuration or user data, and
uninstalling preserves the data directory by default. Source checkouts and
desktop packages do not depend on each other's data directories.

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
Global persona is the sole exception, and it may carry only abstract interaction
tendencies across scopes—not facts from either scope.

A project in Cleo chat is an optional logical memory boundary for a long-running
topic, plan, or workflow; it does not require a code directory, and `general`
is the default. The productivity UI instead treats normalized `cwd` as the
user-visible project identity. Its project picker lists recent workspace
directories without mixing in Cleo memory projects or Codex native threads.
The internal session `project` field still partitions Cleo-owned records and
defaults to the folder name; the harness code boundary always comes from `cwd`
or the repository.

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
├── persona.sqlite3
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

`memory/persona.sqlite3` is the single cross-project and cross-space memory store.
It contains only persona traits and private event evidence. The root-level
`PERSONA.md` is a readable projection that omits project/session provenance and
is loaded by foreground Cleo as lower-authority descriptive memory.

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
  → Sentence Transformer comparison against durable/transient prototypes
      → clearly transient: record processed_hash + skipped; do not start DreamAgent
      → durable or uncertain: continue to DreamAgent (fail open)
  → read project memory in the same scope and global PERSONA.md
  → atomic memory + evidence_event_ids
  → optionally store project-independent persona trait + evidence
  → atomically render MEMORY.md
  → atomically render root PERSONA.md
  → explicitly complete consolidation
```

Non-productivity consolidation emphasizes user facts, preferences, goals, and
corrections. Productivity consolidation emphasizes task intent, technical
decisions, changed files, tests, errors, artifacts, and unfinished work.

DreamAgent independently selects a model profile from `profiles.agents` through
`active_profiles.dream_agent`. Legacy configurations fall back to the foreground
`active_profiles.agent` selection when this field is absent.

Automatic consolidation never edits `AGENTS.md` and never creates or updates a
skill. Persona may describe only communication, expression, relationship
continuity, adaptation, and interaction boundaries; it cannot contain project
facts, permissions, policy, or tool instructions.

The gate reads only bounded human text from the validated compact projection and
lazily loads its model inside the active consolidation process. `processed_hash` means the
source completed gating/processing; `consolidated_hash` remains reserved for a
source that actually entered the project-memory protocol, so gate-skipped threads
remain movable under the unconsolidated-thread rule.

## Runtime State

`data/runtime.json` only stores the active CLI space, project, thread, and
space-partitioned project/recent-thread lists. It contains no transcript and is
not the session registry.
