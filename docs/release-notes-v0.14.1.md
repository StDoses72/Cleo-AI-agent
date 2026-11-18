# Cleo v0.14.1

Cleo v0.14.1 keeps your reading position while a reply is written, streams Claude replies as they are written, fixes Claude tasks that stayed "running" after the reply was complete, and removes several repeated or misleading parts of the conversation and sidebar.

## Reading a reply while it is written

- Sending a message no longer pins the view to the end of the reply. If the question has room beneath it, nothing moves. If it sits at the bottom, it moves up once so the question and the start of the reply are both visible, and the view then stays where it is.
- Output keeps arriving wherever you are reading. The view follows the end of the reply only after you scroll to the bottom yourself, and stops following when you scroll up.
- The "jump to latest" arrow shows when there is output below the view.

## Claude

- Replies and thinking on Claude development tasks appear as they are written instead of one finished block at a time.
- A Claude task no longer stays "running" after its reply is complete. This happened when a background command finished while the turn was still working: Claude reads that completion inside the same turn, and Cleo kept waiting for a separate reply that never comes. Cleo now waits up to 3 seconds after such a turn for a follow-up reply and ends the turn if none starts.
- An instruction that was queued for a running turn and then cancelled, or not delivered, is one status line that opens on its text and can be restored to the composer. It is no longer shown as a sent message.
- A cancelled run says "Run cancelled". The warning that a tool did not complete appears only when a tool was actually left running.

## Conversation and sidebar

- A running conversation stays in its own project, standalone or chat group, marked by a pulsing dot. The separate Running group is removed. Conversations waiting for approval or an answer are still listed under Needs you.
- A command summary with failed commands keeps a neutral icon and its failure count. Red is kept for a task that failed.
- Tool details stay folded until you open them, including failed commands with output.
- Clicking or selecting text in the conversation no longer draws an orange outline around the whole pane. Keyboard focus is still marked.
- Run settings in the details panel no longer repeat the permission preset. The preset is chosen in the composer; file access and approval policy stay in the panel, and both places show the same values.

## Development

- `scripts/update_project.py` resolves Python dependencies with local `uv` only. The Docker resolver, the `docker/` directory and `.dockerignore` are removed. `--local-resolver` and `--skip-build` are still accepted and do nothing.

## Updating

- Conversations, memory and settings are not touched. Timeline indexes keep their format.

## Documentation

- [ADR 0012](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.1/docs/adr/0012-claude-notices-read-inside-a-running-turn.md) records why a completion notice read inside a running turn is not waited for, and what is not verified.
- [ADR 0013](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.1/docs/adr/0013-reading-position-is-the-readers.md) records the reading-position rule.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.1/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.1/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.1/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.1/Cleo-linux-x64.deb)
