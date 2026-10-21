# Cleo v0.10.2

Cleo v0.10.2 improves harness handoffs, reasoning-effort controls, and settings-window layout.

## Fixes and improvements

- Picking a harness or model now waits until the next message is sent. Picking the current harness and model again cancels the pending choice without a backend handoff.
- Failed handoffs restore queued messages and their attachments while preserving the separate composer draft. Both automatic queue delivery and manual retries retain unsent work.
- Changing models within the same Codex harness preserves Fast mode and displays the correct speed before sending. A rejected speed update keeps the message unsent and reports the live runtime.
- The reasoning-effort slider previews locally during dragging and commits once on release. Failed updates restore the actual effort, and the same selection can be retried.
- The settings dialog stays centred with proportional gutters as the window is resized, keeping the dialog inside the viewport.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.2/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.2/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.2/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.2/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages retain the existing ad-hoc signing approach; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.10.2/docs/PLATFORMS.en.md) for installation details.

Included PRs: #124 and #125.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.10.1...v0.10.2)
