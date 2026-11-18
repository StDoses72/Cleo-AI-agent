# Cleo documentation

[中文](README.md) | [Project overview](../README.md)

Guides for installing, configuring, and using Cleo Desktop.

## Use Cleo

1. [Getting started](GETTING_STARTED.en.md): install Cleo, configure a model, and start a conversation.
2. [Platforms and installation](PLATFORMS.en.md): packages, data locations, and updates on Windows, macOS, and Linux.
3. [Configuration](CONFIGURATION.en.md): model profiles, development harnesses, tools, and local data.
4. [Program versions and recovery](program-versions.en.md): update, switch versions, roll back a failed start, and reach the fallback program.
5. [Local skills](local-skills.en.md): discover and invoke skills in development sessions.
6. [Subtask routing (Chinese)](benchmark-routing.md): connected candidates, Artificial Analysis data, evaluator selection, constrained delegation, and task usage.
7. [Computer use (Chinese)](computer-use.md): the per-conversation built-in browser and local computer control.
8. [Release notes for v0.14.1](release-notes-v0.14.1.md); earlier versions are in `release-notes-v*.md`.

## Understand and develop the project

- [Architecture](ARCHITECTURE.en.md): components, sessions, harnesses, and memory flows.
- [Development and releases (Chinese)](DEVELOPMENT.md): setup, checks, packaging, and dependency management.
- [Desktop subsystem (Chinese)](../ui/README.md): Electron, React, and IPC.
- [Repository guidance](../AGENTS.md): contribution rules.
- [Memory design record (Chinese)](CASTMIND_MEMORY_MIGRATION.md): design history and decisions.
- [Harness questions and turn lifecycle (Chinese)](harness/interactive-lifecycle.md): the native question, approval, turn-end, and background-task protocols of Claude, Codex, and ACP; how Cleo adapts them; and the assessment of a per-harness adapter layer.

## Architecture decision records

Decisions that change the architecture, data model, or a user-visible behaviour boundary are recorded under `docs/adr/` (Chinese). Each record explains why the option was chosen, what was rejected, and which limits remain.

- [ADR index and conventions](adr/README.md)
- [0001 Failed memory sources retry automatically with bounded backoff and from the queue](adr/0001-retry-failed-memory-sources.md)
- [0002 An existing conversation can join a project of its space](adr/0002-move-conversation-into-project.md)
- [0003 The built-in browser is per conversation, created on demand, and reclaimed after 10 idle minutes](adr/0003-per-conversation-built-in-browser.md)
- [0004 The Claude turn and background-task lifecycle belongs to the provider](adr/0004-claude-turn-and-background-task-lifecycle.md)
- [0005 The Codex CLI ships once, from the Python runtime only](adr/0005-single-codex-cli-distribution.md)
- [0006 Online runtime ownership registry and evidence-based retirement](adr/0006-online-runtime-ownership-and-retirement.md)
- [0008 Single-sidebar information architecture, flat visuals, and a review and git loop for the desktop UI](adr/0008-single-sidebar-flat-ui-and-review-loop.md)
- [0009 Local evolution is removed; the version infrastructure it shared with official updates is kept and renamed](adr/0009-remove-local-evolution.md)
- [0010 Loading the workspace does not grow with history; a projection version is raised only when an old index is wrong](adr/0010-startup-cost-independent-of-history.md)
- [0011 One context measure for every harness; account usage is read on demand when the panel opens](adr/0011-one-context-measure-and-on-demand-account-usage.md)

The main usage guides have Chinese and English editions. Research notes and internal development references retain their original language.
