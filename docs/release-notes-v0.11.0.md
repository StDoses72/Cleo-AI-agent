# Cleo v0.11.0

Cleo v0.11.0 adds explicit Chinese and English interface languages and improves long replies, screenshot pasting, and reading space.

## Highlights

- Choose **简体中文** or **English** in Settings → Appearance → Language. The selection is saved with runtime state and survives closing Cleo, restarting it, and program updates. Language selection is explicit and does not follow the operating system.
- Switch the interface, application-owned messages, tray menus, recovery screens, and companion window between Chinese and English. User messages, model responses, names, paths, and code retain their original text.
- Keep drafts, active replies, pending questions, and prepared tasks intact when switching languages. A paused streaming reply stays visible until its final answer is saved.
- Display full replies and thoughts directly without a Show full text action. Tool output and commands retain their separate paged reader, with retries and duplicate-page protection.
- Paste screenshots into the desktop composer without relying on a renderer Buffer global, and use a wider reading column for long content.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.11.0/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.11.0/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.11.0/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.11.0/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages retain the existing ad-hoc signing approach; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.11.0/docs/PLATFORMS.en.md) for installation details.

Included PRs: #139 and #143.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.10.3...v0.11.0)
