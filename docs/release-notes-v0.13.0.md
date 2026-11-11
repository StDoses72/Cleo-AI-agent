# Cleo v0.13.0

Cleo v0.13.0 rebuilds the desktop interface around one sidebar, a work log and a review-and-git loop, adopts a flat visual style, and removes local evolution. Official updates, version switching, safe restart with rollback and recovery are kept.

## One sidebar and a flat interface

- The four-space icon rail is gone. One sidebar holds new task, search and memory, then work that needs you or is running, development tasks grouped by project, and chats. Cleo worktrees nest under their repository, and subtasks delegated by subtask routing nest under the conversation that started them.
- Settings sits at the bottom of the sidebar. When the sidebar is hidden (a narrow window with the details panel open, or collapsed by hand), a settings button appears in the conversation header.
- Panes are flat, separated by hairlines, with small radii and no pills or floating cards. Pop-ups and secondary windows (approval card, dialogs, restart and recovery windows, the computer-control bar) use the same style and follow the app's chosen theme.
- The details panel has four tabs: Changes, Files, Details and Computer. Details merges the former Run and Context tabs and now holds per-task permissions, which moved out of Settings. The panel can be widened for review.
- Settings are regrouped into General, Models & agents, and Memory & data. The Dream Agent model and background consolidation share one page. The per-session "Run settings" page is removed.

## Work log, review and git

- Each turn's thinking and tool calls form one chronological, summarised row. Commands show their exit code and duration, finished plans fold, and an answer ends with its subtasks, who did the work (main model, subtask jobs, reviewer) and a changes card whose files open their own diff.
- Each user message shows the saved memory preferences that turn was given.
- Changes show file line numbers and syntax colour. You can revert one file or one hunk, write line notes (by mouse or keyboard) and send them to the agent, commit only the task's files, push, open a pull request and follow its checks. Review notes are kept per repository and branch; when a checkout is switched outside Cleo, notes wait until the branch is confirmed and the panel says why.
- A new task can start in an isolated git worktree. Git actions, undo and new tasks are serialised per checkout.
- The composer supports `@` file mentions, lists the harness's models directly with a segmented effort control, and offers Queue or Steer while a turn is running. Esc stops the run.
- Keyboard: the palette (Ctrl K) searches commands and every conversation; Ctrl / shows the shortcut sheet; Ctrl Tab switches conversations; Ctrl L focuses the composer; Ctrl Shift M and Ctrl Shift A open the model and access menus. System notifications report tasks that finish or start waiting while you are elsewhere.

## Local evolution is removed

- Cleo no longer edits, builds and applies its own source from inside the app. The evolution page, acceptance cases, companion and monitor windows, in-app PR contribution, merge assistance and in-app release publishing are gone, together with the managed build tools and the optional "self-iteration tools" setup item. The reasons and the full list are in [ADR 0009](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.13.0/docs/adr/0009-remove-local-evolution.md).
- To change Cleo itself, open its repository as an ordinary development project and use the review-and-git loop above.
- Official updates are unchanged: Settings → About & updates still checks releases and lets you choose another version. Cleo restarts into the selected program, returns to the previous one if it fails to start, and keeps a fallback program. Version recovery, formerly inside the evolution page, is now on the same settings page.
- Existing installations keep their data. The control directory, `state.json` and release manifests keep their format, and chats, memory and settings are not touched.

### Before you update

- If an earlier version still has unfinished evolution changes (an iteration that was neither saved nor discarded), save or discard them there first. Otherwise the update is refused, with a message that points to recovery.
- Conversations from the evolution page stay available. They now appear in the sidebar as an ordinary project, where you can read or delete them.
- Local versions saved earlier remain on disk and can be selected from version recovery.
- Release packages no longer bundle `evolution-source.tar.gz`, and the `--cleo-import-bundle` option is removed.

## Fixes

- Chat model errors show the provider's own message (for example `Error code: 500 - …`) instead of the raw response body some SDK versions print.

## Documentation

- [ADR 0008](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.13.0/docs/adr/0008-single-sidebar-flat-ui-and-review-loop.md) records the interface decisions, with the design notes and review scores in `docs/UI_UX_REFACTOR_v2.md`.
- [ADR 0009](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.13.0/docs/adr/0009-remove-local-evolution.md) records the evolution removal and its data-compatibility guarantees. `docs/program-versions.md` describes updates, version switching, rollback and recovery as they are now.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.13.0/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.13.0/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.13.0/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.13.0/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages retain the existing ad-hoc signing approach; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.13.0/docs/PLATFORMS.en.md) for installation details.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.12.2...v0.13.0)
