# Cleo v0.9.0

Cleo v0.9.0 combines incremental conversation persistence, safer automatic backup retention, refreshed desktop branding, and composer improvements. It also includes the tray and background memory work merged since v0.8.2.

## Highlights

- Save compact conversation data and search fragments incrementally after each turn, retaining the existing source SHA-256 and logical conversation order. Missing historical search fragments now trigger recovery from the original event log.
- Keep at most three complete automatic user-data backups, preserving snapshots referenced by recovery and retrying interrupted cleanup safely.
- Use Cleo's own icon in Windows executable resources, macOS packages, Linux launchers, and the application interface. Windows windows and the tray share the platform-specific icon.
- Give composer dropdowns proportional arrow spacing and allow their controls to wrap in narrow layouts. Pending permission details remain available in the selector tooltip.
- Keep Cleo available in the tray after closing its window, with configurable background memory processing. Rewind markers remain durable, and background memory publication is drained before rewinding.

## Upgrade and downgrade notes

Original `events.jsonl` files, conversations, memory, and configuration remain authoritative and are not migrated. The rebuildable `compact.json` cache now uses storage version 3; the new application also reads version 2.

Older applications cannot read version 3 directly. Before downgrading, close Cleo and use the **v0.9.0 Python environment** with the same `CLEO_HOME` to export the version 2 cache and legacy search index:

```python
from cleo.config.settings import settings
from cleo.sessions.store import SessionStore

store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
for session in store.list_sessions():
    store.export_legacy_compact(session["id"])
```

This export leaves original events unchanged. Returning to v0.9.0 rebuilds version 3 when the session is refreshed. The three-backup retention limit applies to complete automatic backups, separately from retained program builds.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.9.0/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.9.0/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.9.0/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.9.0/Cleo-linux-x64.deb)

Installers prepare the verified runtime dependencies during installation. Each package has a matching SHA-256 file. macOS packages retain the existing ad-hoc signing approach; see the [platform guide](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.9.0/docs/PLATFORMS.en.md) for installation details.

Included PRs: #104, #111, #112, #114, #115, and #116.

[Full changelog](https://github.com/StDoses72/Cleo-AI-agent/compare/v0.8.2...v0.9.0)
