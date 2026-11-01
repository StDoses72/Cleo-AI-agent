# Cleo v0.12.2

Cleo v0.12.2 adds benchmark-assisted subtask routing, configurable evaluators and task-scoped usage while keeping the selected main model in charge. It also fixes Claude task identity on reconnect, isolates computer bridge connections, completes the background-task lifecycle, and includes the reviewed browser, memory, project and runtime-storage fixes.

## Subtask routing and task usage

- Choose a connected harness/model directly or enable subtask routing. The main model still understands the request, decomposes work, controls parallelism, checks results and gives the final answer. Routing selects only eligible connected execution configurations; explicit user selections and disabled candidates remain authoritative.
- Artificial Analysis supplies cached capability, price and speed references. A configurable API or harness evaluator recommends workers from the eligible catalog, or the deterministic rules can be used. An unspecified evaluator follows the new-conversation default model; its assessment is reused when it is already coordinating. Missing data stays unknown and uses a configured conservative fallback; benchmark refresh failures retain the latest valid cache.
- Search and select allowed models in compact routing settings, configure the AA data connection and calibrate model versions. Confirmed unsupported account/harness/model combinations are excluded within their runtime scope without paid inference probes.
- The current-task panel shows a concise task label and each model's responsibility, calls, reported tokens and available dollar costs. Related follow-ups stay in the same task; an evaluator can start a new task boundary for a new goal. Context occupancy uses the selected model's known capacity rather than the output-token setting. Missing usage or prices are not presented as zero; API-equivalent subscription costs are distinct from an invoice.
- Routing records execution, acceptance and attributable feedback separately. Eligible retries/upgrades are bounded and cancellation never retries automatically. Confirmed feedback can make a limited, reversible local ranking adjustment; it does not train models or alter AA benchmark scores.
- Existing routing/evaluator configuration remains local. Direct API connections can evaluate tasks, but this release does not add a direct API worker or make an arbitrary model compatible with another harness.

## Permissions, complete output and recovery

- A configured routing permission preset applies consistently to the coordinator and workers. Handoff discards stale queued permissions belonging to the old harness, while unsupported permission combinations remain ineligible.
- Claude reconnects retain the same host-bound task key for memory, routing and computer tools. Computer bridge descriptors are unique per desktop instance, and a rejected second instance cannot replace the running instance's connection. Ownership validation stays in place; independent worker processes do not acquire desktop ownership just from a parent-binding file.
- Conversation messages render complete content inline, including safe full-text loading, retry and copy for older preview records. Tool-output readers remain available.
- The Evolution companion appears during an Evolution handoff only when the main interface is unavailable, and closes automatically when the main interface becomes ready. Independent recovery remains available.
- An opt-in local configuration preview lets the browser sidebar read connections and edit routing settings through restricted local RPCs, with credential redaction and origin/token checks. It cannot start inference.

## Harness lifecycle

- A Claude Code `ResultMessage` no longer ends the turn while background tasks (`Bash(run_in_background=true)`, background agents) are still running. Cleo consumes the whole stream, records each stage as `claude/stage_completed`, counts the wake-ups owed after every `task_notification`, and finishes only when no task remains and every owed result has arrived, so a final reply that arrives after several tasks complete together is not lost. Ambient session watchers never hold a turn open.
- Waiting is bounded by `CLEO_CLAUDE_BACKGROUND_WAIT_SECONDS` (600 by default, measured as silence between frames). A timeout ends the turn as `failed` with the reason, cancelling while waiting ends it as `cancelled`, and `0` means "do not wait" and returns the stage reply as completed. All three abandon the remaining tasks and reconnect the native session on the next prompt.
- The native question, approval, turn-end, and background-task protocols of Claude, Codex, and ACP, how Cleo adapts them, and why no extra adapter layer is added are documented in `docs/harness/interactive-lifecycle.md`.

## Built-in browser

- Each conversation has its own browser: tabs, logins (`Partitions/cleo-browser-thread-<id>`), downloads, screenshots, control, and action queue are no longer shared, and two conversations can drive their own pages at the same time. The real desktop keeps a single global lease.
- Pages are created on demand: creating or switching a conversation does not start a web view, and closing the last tab leaves the browser empty.
- After 10 minutes without tool calls, panel actions, or typing (page animations and polling do not count), and with nothing running, downloading, or waiting for input, a conversation's pages sleep to free memory. The conversation shown in the panel never sleeps; its clock restarts when you switch away. Reopening reloads the saved addresses and keeps logins.
- Stop in the panel only stops the current conversation; the emergency shortcut still stops everything. The takeover overlay follows the conversation being shown.
- The earlier shared profile `Partitions/cleo-browser` is kept on disk but no longer used; sign in again inside each conversation that needs it.

## Conversations and projects

- A conversation or development task started under General can join a project of the same space from its "Move to project…" menu entry or with `/project move <name>`, keeping its ID, title, messages, and attachment references. Running threads, cross-space targets, self-evolution tasks, consolidated sources, and tasks carrying a harness handoff snapshot are refused with a stated reason.
- After a development task moves, later turns run in the target project directory; the resident harness session is closed and resumed there, and the previous turn's Git undo checkpoint is discarded. Files, Git repositories, and attachments are not moved.

## Memory

- A memory source whose consolidation failed because of a provider or network error is retried automatically with exponential backoff (interval × 2^(n−1)), up to three attempts per source revision; new conversation events reset the budget. Saving the background consolidation settings re-arms one attempt. The queue shows a retry button for failed sources.

## Packaging and storage

- The Codex CLI ships once, from the Python `openai-codex-cli-bin` package. `ui/runtime/package.json` no longer declares `@openai/codex`, which saved about 0.43 GiB per online runtime, and the release receipt refuses to be generated if the npm package reappears.
- Every start on an online runtime records which installation uses which runtime key in that runtime's `installations.json`, including the keys an installation has left. Storage cleanup labels runtimes `in-use`, `retired`, or `unknown` from this registry and reclaims only runtimes proven retired; unknown ownership is still kept.

## Build compatibility

- Apple Silicon CI uses the supported native `macos-15` image. The retired macOS 14 runner is also removed from download-page checks; Intel packages remain on `macos-15-intel`.

## Documentation

- Architecture decision records live in `docs/adr/` with conventions in `docs/adr/README.md`; this release accepts ADR 0001–0006.
- `docs/computer-use.md`, `docs/ARCHITECTURE*.md`, `docs/DEVELOPMENT.md`, and `docs/cleo-evolution*.md` describe the behaviour above.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.12.2/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.12.2/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.12.2/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.12.2/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages retain the existing ad-hoc signing approach; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.12.2/docs/PLATFORMS.en.md) for installation details.

Included PRs: #153, #154, #155, #156, #157, #158, integrated with routing and release preparation in #159. Fixes #141, #142, #148, #149, #150 and #152.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.12.1...v0.12.2)
