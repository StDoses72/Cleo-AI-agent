# Cleo v0.10.3

Cleo v0.10.3 simplifies project selection and improves permission menus and sidebar navigation.

## Fixes and improvements

- The project picker lists real projects only. Clearing the selected project returns the draft to a standalone task or conversation while preserving its text and attachments; it never removes the project itself.
- Removed the standalone-project row and the explanatory text beneath Add project.
- Session permission presets use a menu above the composer with keyboard navigation and scrolling. In settings, Escape closes only the permission menu and restores focus; pressing Escape again closes settings. IME composition does not dismiss the menu.
- Collapsing a project folder resets Show more for that folder. Reopening shows the short list while keeping the selected task visible.
- Removed the prepared-handoff hint above the composer.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.3/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.3/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.3/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.3/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages retain the existing ad-hoc signing approach; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.10.3/docs/PLATFORMS.en.md) for installation details.

Included PR: #131. Fixes #126, #128, #129 and #130.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.10.2...v0.10.3)
