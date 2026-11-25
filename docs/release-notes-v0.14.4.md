# Cleo v0.14.4

Cleo v0.14.4 stops a conversation from jumping back to the same earlier messages while you scroll through it, gives a long conversation everything it should show when you open it, and finds the Claude Code that the Claude desktop app keeps on a Mac.

## Scrolling through history

- Scrolling down through a conversation no longer brings the same earlier messages back again and again. It happened around a turn with several hundred tool calls: folded, they are one line, but they fill the 500 items Cleo keeps loaded, and Cleo then loaded the page behind you. Scrolling up could also get stuck below such a turn.
- More history is loaded only in the direction you are scrolling. Turning round takes effect with your next scroll.
- Crossing such a turn turns the page: once you reach the edge, the messages behind you give way to the ones ahead. Nothing on the way is skipped. The 500-item limit is unchanged.
- A folded turn you opened stays open while history loads around it.
- Your place is kept when earlier history arrives while you scroll against the top of what is loaded, and when a reply finishes while you are reading further back. The pages you had opened used to be replaced by the newest one.
- This was reproduced and checked with a conversation of the reported shape (623 items, one turn of 502 tool records), not with the reporter's own conversation.

## Opening a conversation

- A long conversation opened from the sidebar now gets its task usage, skills, changes, editable messages and undo state. They were dropped whenever the whole conversation arrived later than its newest page, which a long conversation always did.
- The conversation no longer waits for its usage to be added up. On a test conversation of 18,451 events (77.5 MB), that part of opening went from 0.41–0.50 s to 0.02–0.03 s. The usage follows about 0.4 s later.
- A conversation whose history index has to be rebuilt still takes that rebuild the first time, about 3 s for the same test conversation.

## Model connections

- On macOS, an account connection for Claude Code finds the Claude Code that the Claude desktop app keeps for itself when there is no `claude` command: the newest version under `~/Library/Application Support/Claude/claude-code/`, chosen again on every check. A `claude` on your path still comes first, and a client path you set is used as given.
- The folder layout was confirmed on the Mac the report came from. The lookup has not yet been run inside an installed Cleo on that Mac.
- Other clients and other platforms are looked for as before.

## Updating

- Conversations, memory and settings are not touched. Timeline indexes and conversation logs keep their format.

## Documentation

- [ADR 0018](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.4/docs/adr/0018-history-pages-follow-the-reader.md) records how history paging follows the reader and what was rejected.
- [ADR 0019](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.4/docs/adr/0019-open-a-conversation-without-its-task-usage.md) records the measurements behind opening a conversation and the separate usage request.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.4/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.4/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.4/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.4/Cleo-linux-x64.deb)
