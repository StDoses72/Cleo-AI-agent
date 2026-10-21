# Cleo v0.10.1

Cleo v0.10.1 brings a project selector to the composer, a grouped task sidebar, and a single runtime settings card.

## Highlights

- Choose the project for an unsent task from the composer, or leave it as a standalone task. Changing projects carries the current draft; adding a project also keeps its text, attachments, and edits made while the folder is being registered.
- Browse projects and their tasks together in the sidebar, with collapsible groups, last-used harness labels, and search across projects.
- Choose permissions before sending the first message. The displayed selection is applied when the task is created, including the default selection. Codex receives its access and approval settings; Claude and ACP receive only their supported approval fields. New tasks retain compatible permissions inherited from an existing task.
- Adjust harness, model, reasoning effort, and Codex fast mode from one runtime settings card. The composer grows with longer drafts before scrolling.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.1/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.1/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.1/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.1/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages retain the existing ad-hoc signing approach; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.10.1/docs/PLATFORMS.en.md) for installation details.

Included PR: #123.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.10.0...v0.10.1)
