# Local evolution

[中文](cleo-evolution.md) | [Documentation](README.en.md)

Use local evolution to describe changes to Cleo, build them, try the resulting program, and save a version you want to keep.

## Everyday workflow

1. Open the evolution view and choose a harness, model, and reasoning level.
2. Describe the change. Cleo prepares source and tools, records requirements, performs the edit, and checks the build.
3. Click Apply (应用) once checks pass. Cleo restarts into the candidate program so you can try it.
4. Confirm the behavior in the acceptance area. Feedback is optional; see [direct acceptance](direct-acceptance.en.md).
5. Save (保存) the version, optionally giving it a name. Continue editing or choose Discard changes (放弃修改) to return to the iteration's starting point.

Editing again invalidates the previous build checks. Rebuild and apply before saving. Version-changing controls are unavailable during preparation, editing, and building. Switching views does not skip automatic build completion.

The version picker offers official releases and saved local versions. Local saving does not publish a GitHub Release. The contribution dialog opens separately from Submit PR (提交 PR).

## Build checks and repair

The desktop controller prepares dependencies, compiles TypeScript, builds the frontend, runs the relevant Node regressions, packages the program, and checks source consistency. Apply and Save depend on those results, not on the agent saying it has finished.

Check results persist in `validation.json`. An interrupted or stale check must be rerun. Use Let Cleo fix (让 Cleo 修复) to send current code diagnostics back to the same evolution task, or Recheck (重新检查) for dependency and preparation failures. Draft text and attachments remain available.

The build gate covers its configured checks and packaging. Behavior acceptance is recorded separately. Protected controller changes are delivered through development packages or official releases.

## Data and version retention

All versions share `CLEO_HOME` and Electron `userData`. Switching programs preserves current chats, memory, and configuration; it does not restore an old data snapshot.

The control directory is `evolution` under Electron `userData`:

| Entry | Purpose |
| --- | --- |
| `builds` | Base, candidate, saved, and recovery programs |
| `source` | Current editing source |
| `source-history-*`, `source-recovery-*` | Retained earlier workspaces |
| `tools` | Private build tools |
| `backups` | Data copies retained before application |
| `state.json` | Version selection and switching state |
| `protected.json` | Protected controller source checks |

Normally Cleo retains the workspace base, current changes, and latest saved local version, plus a protected fallback program when distinct. Superseded programs are cleaned after successful startup or saving. Files still in use are queued for later cleanup. Data, source history, backups, and tool caches are separate from program cleanup.

## Startup and recovery

Application and rollback use a visible restart controller. It waits for both the main window and backend to become ready. If startup fails, it tries the previous program and fallback; if all attempts fail, the recovery selector stays available. Saving a version does not restart Cleo.

Release manifests use `evolution_protocol: 2` for switching with current data preserved. A development bundle can be imported with `--cleo-import-bundle`; reopening the same bundle does not override a later version choice.

Storage changes must preserve compatible readers, fields, IDs, and unknown data. Version switching does not itself convert or downgrade data formats.

## Harnesses and contributions

Evolution uses the development harness/model picker. Codex uses `workspace-write` / `deny_all`; Claude uses `acceptEdits`; ACP retains its own permission controls. Memory MCP starts in isolated Python mode with the Cleo package path added explicitly.

Connect GitHub (连接 GitHub) uses GitHub CLI device authorization and reuses an existing valid login. Credentials are managed by GitHub CLI. After connecting, select a checked local version and a receiving branch to contribute its source. See [source contributions](contribution-targets.en.md).
