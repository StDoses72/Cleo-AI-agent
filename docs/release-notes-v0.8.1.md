# Cleo v0.8.1

Cleo v0.8.1 refreshes the desktop interface and improves execution-plan visibility across coding agents.

## Highlights

- Introduce the Linen theme with warmer surfaces, larger text, calmer progress displays, and matching light and dark appearances.
- Show each conversation's harness or model, mark new replies in inactive conversations as unread, and display unread counts on the application icon.
- Refresh approval prompts with clear allow/deny choices and a selector for one-time or session-wide approval.
- Render LaTeX mathematics in messages, thinking content, and Markdown file previews using bundled KaTeX assets.
- Display Codex `inProgress` and `in_progress` plan steps as running. Rebuild cached timelines so existing conversations receive the corrected statuses.
- Show plans from Claude TodoWrite and OpenCode-style ACP TodoWrite notifications while preserving original tool records and native ACP plan support. Repeated updates share one card per turn, and delayed callbacks stay isolated from later turns.

## Upgrade notes

- Existing conversations, memory, configuration, and backend architecture are preserved; the timeline cache is rebuilt automatically when needed.
- OpenCode compatibility uses its structured TodoWrite tool notifications. No OpenCode-specific provider or additional configuration is required.
- New installations default to the light theme; an existing saved theme choice is retained.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.8.1/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.8.1/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.8.1/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.8.1/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages use ad-hoc signing; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.8.1/docs/PLATFORMS.en.md) for installation details.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.8.0...v0.8.1)
