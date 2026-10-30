# Cleo documentation

[中文](README.md) | [Project overview](../README.md)

Guides for installing, configuring, and using Cleo Desktop and its terminal workflows.

## Use Cleo

1. [Getting started](GETTING_STARTED.en.md): install Cleo, configure a model, and start a conversation.
2. [Platforms and installation](PLATFORMS.en.md): packages, data locations, and updates on Windows, macOS, and Linux.
3. [Configuration](CONFIGURATION.en.md): model profiles, development harnesses, tools, and local data.
4. [Local evolution](cleo-evolution.en.md): describe a change, apply a build, and save or restore a version.
5. [Acceptance](evolution-acceptance-preparation.en.md): prepare requirements and confirm behavior after application.
6. [Local skills](local-skills.en.md): discover and invoke skills in development sessions.
7. [Source contributions](contribution-targets.en.md): request a receiving branch and submit a source snapshot.

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

The main usage guides have Chinese and English editions. Research notes and internal development references retain their original language.
