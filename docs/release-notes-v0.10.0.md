# Cleo v0.10.0

Cleo v0.10.0 adds storage usage and cleanup controls, development tasks without a selected folder, and refreshed Windows launchers after official updates.

## Highlights

- Inspect Cleo's storage usage in Settings → Data and memory. See which runtimes, dependency snapshots, caches, and downloaded packages can be reclaimed and why other entries are retained. Cleanup protects user data and retained programs, journals interrupted removals, and retries locked entries later.
- Preserve the runtime of an installed Windows application in a custom directory by discovering its registered installation location, including installations that have never created an evolution registry or dependency snapshot.
- Start a development task without choosing a folder. These tasks use Cleo's managed general workspace, displayed as General / No folder. Existing sessions retain their saved working directories.
- Show workspace rail dots for unread completed replies and clear them when their thread is opened. Move the runtime-check action into the settings navigation footer.
- Refresh the installed Windows entry point after a healthy official update so its executable icon and version follow the active program. Channel checks, junction-aware data protection, and a recoverable directory swap preserve the existing installation when refresh cannot finish.

## Known limitation

External installers and storage cleanup do not share an installation lock. Before running an external installer, close other Cleo instances and wait for any storage cleanup to finish. Concurrent installation and cleanup can remove a newly prepared runtime before the application reaches its installation directory; rerunning the installer restores the runtime.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.0/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.0/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.0/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.10.0/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages retain the existing ad-hoc signing approach; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.10.0/docs/PLATFORMS.en.md) for installation details.

Included PRs: #119, #120, and #121.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.9.0...v0.10.0)
