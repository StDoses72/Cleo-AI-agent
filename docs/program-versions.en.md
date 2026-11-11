# Program versions and recovery

[中文](program-versions.md) | [Documentation](README.en.md)

This page describes how the desktop app retains, switches, and recovers program versions. Cleo used to offer local evolution (letting Cleo edit its own source, build it, and save local versions). That feature has been removed; see [ADR 0009](adr/0009-remove-local-evolution.md) for the reasons and the compatibility guarantees. Version switching, the visible restart, automatic rollback, and the independent recovery entry point were shared with it and now serve official updates.

## Updating and switching

1. Check official releases in Settings → Updates. Installed builds check every six hours; downloading and installing always need a user action.
2. Other versions (其他版本) offers earlier and pre-release versions. Manifests and packages are verified for platform, version, length, and SHA-256 before use.
3. Restart and install hands the verified program to the restart controller: the running program exits, the controller backs up data, switches programs, and waits for the new program to confirm startup.
4. If startup fails, Cleo returns to the previous program and then to the fallback program. If every attempt fails, the recovery window stays open for a manual choice.

A finished download never installs itself at the next start. After running a newer installer by hand, the first start switches to the installed program through the same recoverable flow. It does not take over when the program in use is a local version saved by an earlier Cleo, or when the registry still records unfinished local changes from an earlier Cleo.

## Data and recovery

All versions share `CLEO_HOME` and Electron `userData`. Switching programs preserves current chats, memory, and configuration; it does not restore an old data snapshot. The backup taken before a switch is a spare copy for accidental damage.

The control directory is `evolution` under Electron `userData`. The name is part of the on-disk format that every retained program reads and writes, including earlier ones, so it did not change with the feature:

| Entry | Purpose |
| --- | --- |
| `builds` | Fallback program, current program, downloaded official versions, and local versions saved by earlier Cleo versions |
| `backups` | Up to three complete automatic data snapshots taken before a switch |
| `downloads` | Verified package cache |
| `handoffs` | Restart controller readiness handshake |
| `state.json` | Program selection, registered builds, switch journal, cleanup queues, and launcher refresh records |
| `releases.json` | Most recently read official release list |

Earlier versions may also have left `source`, `source-history-*`, `source-recovery-*`, `tools`, `acceptance`, `validation.json`, `protected.json`, and `release-jobs` here. The current program neither reads, writes, nor deletes them. An official switch still archives `source` as `source-history-*` under the same journal and restores it if the switch fails.

The first time Cleo installs an update or opens version recovery from inside the app, it retains the working program as the fallback. On Windows it also creates a Cleo 恢复 desktop shortcut (Cleo Alpha 恢复 on the alpha channel) that starts with `--cleo-recovery`. The fallback entry point does not depend on the main window or the Python service, so it works when the main program cannot start. The fallback program is never cleaned automatically.

## Retention and cleanup

Normally Cleo retains the fallback program, the current program, and a freshly downloaded official version; a program in several roles is stored once. References recorded by earlier versions (latest saved local version, iteration base, workspace base, candidate build) stay protected so those versions remain usable after returning to them.

The previous program stays until the new one confirms startup. Files still in use are queued for later cleanup. Program cleanup only touches `builds` in the control directory; user data, source archives, and tool caches are separate.

Automatic data backups have a separate limit of three complete snapshots. Backups referenced by the current switching transaction and the last switch take priority and count toward that limit; the remaining slots retain the newest snapshots by their recorded creation time. Cleanup runs after a new backup is complete and journaled, and after successful startup, including for accumulated older backups. Copying can temporarily add another snapshot; failed deletions are recorded and retried later. Only complete, Cleo-managed `apply-UUID` snapshots under `backups` are eligible. Unrelated directories, links, and snapshots whose completeness cannot be established are left untouched, as is the current `CLEO_HOME` data.

Every start on an online runtime records, in `installations.json` at that runtime's root, which installation location uses which runtime key and version. When the same installation switches to a new key (an in-place upgrade), the key it left and the time it left stay in that entry's `history` until the old runtime directory is gone, so a newer registration never overwrites the evidence that an installation has moved on. The storage inventory labels every online runtime from this registry: `in-use` (the running program, a registered build, an installed launcher, another channel, a dependency snapshot, or a launch registration still points at it), `retired` (superseded by a healthy newer version, or every installation registered on it has moved to another runtime or no longer exists, with no other reference), or `unknown` (complete, but nobody can prove it is in use; it is kept). Entries carry `owners` with the kind of evidence and `evidence` for retirement. A missing, corrupt, or mismatched registry never authorizes deletion, and retirement by registry goes through the same health, transaction, installation, and download gates as version-based cleanup.

## Packages

Release manifests use `evolution_protocol: 2` for switching with current data preserved, and `3` for online packages. The field keeps its earlier name because published programs read it by that name. Packages up to v0.12.2 carry `evolution-source.tar.gz` beside `app.asar`; newer packages do not, and both are recognized.

## Startup and recovery windows

Switching and rollback use a visible restart controller. It waits for both the main window and the backend to become ready; process creation alone is not success. The wait is at most 90 seconds, enforced by the program that started the switch, so installed versions cannot change it: the new program must load its workspace and confirm within that time, and loading the workspace must not grow with the size of the history ([ADR 0010](adr/0010-startup-cost-independent-of-history.md)). If startup fails, it stops the failed program, then tries the previous program and the fallback. If all attempts fail, the progress window turns into a recovery selector that stays available.

## Compatibility with earlier versions

- Versions up to v0.12.2 can still be selected and run as retained programs; local evolution keeps working inside those versions.
- When the registry records unfinished local changes from an earlier version (an iteration or an unsaved candidate build), the current program refuses an official switch and asks you to return to that version through recovery to save or discard them. It does not archive or clean them on your behalf.
- Local versions saved by an earlier version can be selected from recovery.
- Earlier tasks in the `cleo-evolution` project still load as ordinary development tasks in their original source workspace.
- Version switching does not convert or downgrade data formats. Storage changes must still preserve compatible readers, fields, IDs, and unknown data.
