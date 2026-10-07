# Cleo v0.8.0

Cleo v0.8.0 focuses on desktop reliability and a clearer backend structure.

## Highlights

- Apply configuration changes without restarting the backend. Running turns retain their original settings, invalid edits preserve the last valid configuration, and the desktop reports configuration problems.
- Preserve accepted task events during cancellation, settle pending callbacks, and finish terminal and harness-handoff records when cancellation arrives after the provider has completed.
- Improve ACP tool names, plans, model selection, approval prompts, and consistency between live updates and saved history.
- Initialize approvals and questions consistently for newly created, resumed, and forked tasks. Live task controls follow their actual harness when configuration changes.
- Recover missing session indexes before new writes. Keep large, excess, and unreadable untracked files visible in the changes panel, and improve undo support for long Windows paths.
- Separate backend startup, run state, commands, chat execution, presentation, and persistence responsibilities, with expanded regression coverage.

## Upgrade notes

- The terminal CLI, Textual TUI, `main.py`, and application Docker/Compose entry points have been removed. Use the desktop application. The Codex and memory MCP entry points remain available.
- Existing v0.7.1 session and memory data remain supported. Cached timelines are rebuilt to apply the corrected tool and plan projection.
- Existing ACP sessions retain their saved approval policy, including `deny_all`. Select `user` in the session's runtime settings to receive approval prompts.
- Changes to data-directory settings require restarting the backend.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.8.0/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.8.0/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.8.0/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.8.0/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages use ad-hoc signing; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.8.0/docs/PLATFORMS.en.md) for installation details.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.7.1...v0.8.0)
