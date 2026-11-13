# Cleo v0.14.0

Cleo v0.14.0 shows a running turn as prose, separates the choice of harness, model and reasoning effort, measures context the same way for every harness, and shows your account usage from the ring beside the send button. Repeated controls and explanatory copy are removed across the interface.

## A running turn reads as prose

- While a turn is running, its thinking is written into the timeline as prose and each run of tool calls is one closed line. Once a reply follows that work, or the turn is over, the stretch folds behind one summary line.
- Tool rows read state, name, command, then exit code and duration, so commands start in one column. A command whose harness did not name its tool counts as a command, not as "other tools".

## Harness, model and effort

- A development task picks a harness and then one of its models from one menu that drills down and is as tall as its list. Reasoning effort is a control of its own, with fast mode and reset in its menu.
- A harness that fails its check stays in the list, marked as not connected.
- Subtask routing is switched in Settings only. The per-task choice and the default-mode select are gone, and a new task follows the setting.

## Context and account usage

- The ring beside the send button now means the same thing for every harness: the input the latest request put in the context window (new input plus cached input) over the window the harness reports. Output is not counted. This is how Claude Code and OpenCode count it themselves.
- Development tasks on Claude, and on ACP harnesses that report usage such as OpenCode, now have a ring; before, only Codex did. Codex's reading is slightly lower than in v0.13.1 because it no longer includes the last reply's output.
- Click the ring to open its panel: context used over the window and, for Codex and Claude, your account's usage windows (for example 5-hour, weekly and weekly per model) with the time each one resets. Usage is read when the panel opens. The first read takes several seconds, and a reading is reused for a minute.
- A value that cannot be read is not shown: no ring without a window, and no usage section for a harness that does not report one.
- The Details tab no longer repeats context usage.

## Less repetition, less copy

- The header diff pill is removed, and the end-of-turn changes card is one line while the Changes tab is open. A turn's duration shows once. The collaboration line no longer repeats the subtasks listed above it, and the Details tab drops what the conversation already shows. A memory entry whose title is its own text shows it once.
- Explanatory, reassuring and hedging sentences are removed or cut down to a state across the composer, settings, dialogs and panels. Confirmations of destructive actions, consent text and real errors stay.
- In the details panel header, widen and close sit together at the right edge.

## Fixes

- A repository without commits shows its branch name instead of git's sentence ("No commits yet on main"). A detached HEAD shows "HEAD".
- The storage settings row no longer overlaps its description, settings navigation keeps its icons when a label wraps, and narrow panes keep the composer tools and the work summary inside their rows.

## Updating

- Conversations, memory and settings are not touched. Timeline indexes keep their format, so neither the update nor a return to v0.13.1 rebuilds them.
- Conversations on an ACP harness recorded before the update get their ring from the next turn on.

## Documentation

- [ADR 0011](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.0/docs/adr/0011-one-context-measure-and-on-demand-account-usage.md) records the context definition, how account usage is read for each harness, and what is not verified.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.0/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.0/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.0/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.0/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages retain the existing ad-hoc signing approach; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.0/docs/PLATFORMS.en.md) for installation details.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.13.1...v0.14.0)
