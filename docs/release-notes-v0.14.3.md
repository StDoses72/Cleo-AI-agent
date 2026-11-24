# Cleo v0.14.3

Cleo v0.14.3 lets the agent choose where computer use happens: the built-in browser, your own Chrome or Edge in the background, or the desktop. It also keeps the text of a Claude reply that was interrupted, makes "Undo last turn" work for binary files on Windows, and offers a reload when the main window fails to show the workspace.

## Computer use: the agent picks the target

- The mode switch at the top of the computer page is gone. Every task starts in the built-in browser, and the agent moves to your browser or the desktop when the task needs it.
- **Your browser** (Chrome or Edge, through the new Cleo extension) is for sites where you are already signed in. Pages are driven on one background tab, so your pointer, window focus, clipboard and the tab you are looking at are not touched.
  - Tabs the agent opens go in a "Cleo" tab group, and it can close only those.
  - Clicking or typing in its target tab hands control to you. Input in other tabs does not.
  - Closing that tab, cancelling the browser's debugging bar, or disconnecting stops the agent. It does not move to another tab or fall back to the real mouse.
- **Websites are approved one at a time** in the conversation: Only this time, Always allow this site, All sites, or deny. Approval applies to the page at the moment of the action. A page that moves to another site while you answer is asked about again.
- **Desktop** control is authorized in the conversation and now lasts one turn instead of the whole conversation.
- The computer page shows only the target in use, what the agent is doing now, take over and stop, and the recent steps with their durations. When the turn ends it shows a summary.
- Approvals appear above the composer. Browser connections, allowed sites and the emergency-stop shortcut are in Settings → Computer use.
- The desktop status bar says what the agent is doing: thinking, taking a screenshot, acting in an app, waiting for an app, waiting for you, paused or failed.
- Launching an app waits for Start search to open and for the new window to come to the front, and reports that window. On the test machine the step went from 1.87 s to 1.38 s and no longer needs a wait-and-screenshot round after it. Whole tasks were not shown to be faster: the model's thinking is 65–95% of a turn.

Limits in this release:

- The extension is loaded unpacked in developer mode until it is published in the stores. Settings shows the three steps.
- Firefox is not supported, and one browser is connected at a time.
- Taking over is not detected for input inside iframes.
- The your-browser path has not been verified on macOS or Linux.

## Claude replies and follow-ups

- The text of a Claude reply that stops before it finishes is kept. It is in the conversation when you reopen it, and a handoff to another harness tells finished messages from unfinished ones.
- While a Claude turn runs, the follow-up button reads "Send next turn", because Claude takes a follow-up when the current turn ends. Its receipt says it is waiting for the turn to finish. Harnesses that accept a follow-up mid-turn keep "Steer".

## Changes and undo

- The Changes list and each turn's change record no longer run a repository's document converters (git `textconv`). On one set of Word revisions a single diff took 21.7 s with the converter and 0.08 s without. Such files are listed as binary. `/diff` still uses the converter.
- "Undo last turn" now restores binary files on Windows, files with LF line endings in repositories that keep line endings as written, and files that have a converter configured. These could not be undone before.

## Window and scrolling

- When the workspace fails to load or its renderer crashes, Cleo offers to reload it instead of leaving a window with only a title bar. If you dismiss the message, opening Cleo again loads the workspace. The condition behind the original blank-window report has not been confirmed on the reporter's machine.
- Scrolling a long conversation no longer renders the rows that stay in view again. In a test of 500 rows and 25 small scrolls, row renders went from 350 to 1.
- On Windows, a taskbar pin of the running app relaunches through the installed entry point, and ordinary Cleo shortcuts on the desktop, Start menu and taskbar that pointed into a versioned build folder are corrected.

## Updating

- Conversations, memory and settings are not touched. Timeline indexes and conversation logs keep their format.
- Desktop control that was authorized for a whole conversation is asked for again on the next turn that needs it.
- Nothing for the browser extension is written to your profile or registered with a browser until you click Connect in Settings → Computer use.

## Documentation

- [ADR 0017](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.3/docs/adr/0017-agent-chosen-computer-modes.md) records the three computer-use targets, the extension link and what was rejected.
- [Computer use](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.3/docs/computer-use.md) describes the modes, approvals and settings.
- [Computer-use measurements](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.3/docs/benchmark-computer-use.md) has the before and after runs and their limits.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.3/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.3/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.3/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.3/Cleo-linux-x64.deb)
