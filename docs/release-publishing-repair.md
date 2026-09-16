# Release publishing repair

## One-click PR release follow-up

The latest request changes the primary interaction to selecting a PR version,
entering a version number, and clicking Publish Release once. The selector now
includes all registered PRs rather than filtering out other local builds. Labels
include retained version names/numbers or the historical PR title/build identity.
The default is a stable release; title defaults to the version and notes may be empty.

The new `publishMergedRelease` action verifies permissions, registered target
repository/branch, merged PR state, the exact merge commit object, and its complete
Git tree before calling the shared, conflict-preserving release creation helper.
It uses GitHub's [merged PR commit semantics](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request),
not a moving branch head or the current running version. It does not prepare,
switch, read, or overwrite the local source workspace. Thus a different active
version, dirty source, or a pruned local build does not block publishing the
verified remote PR. The earlier explicit local-source API and its regression
checks remain intact; the primary UI no longer calls that API.

Source selection clears previous results; publishing automatically re-verifies
the selected PR. Invalid versions, unmerged PRs, permission failures, changed
accounts, incomplete source trees, and conflicting remote tags remain blocked.
Repeated clicks are locked out; errors retain inputs for retry. Optional package
publication/recovery remains in a collapsed section, including recovery of partial
drafts, without adding a required step to ordinary Release creation.

Verification for this follow-up:

- `node --test ui/tests/evolution-release-publish.test.mjs`: 47 passed, including
  the existing regressions and new remote-source/defaults/selection/retry cases.
- Installed TypeScript compiler and Vite via `npm run build`: passed; existing
  large-chunk warning remains.
- `node ui/scripts/smoke-release-selection.mjs`: passed in isolated Chrome with
  simulated GitHub actions, including one-click defaults, invalid/empty versions,
  changed sources, unmerged rejection, retries, duplicate submission protection,
  permissions, optional package recovery, and desktop/mobile layout.
- Workflow Python tests: all 11 passed. Main module syntax and `git diff --check`
  also passed. This follow-up did not change the workflow or persistence formats.
- Screenshots were inspected and the generated PNGs removed after verification.

Real publishing and frozen manual acceptance cases remain unverified. No real
GitHub mutation, program application/restart, protected controller change, or user
data/profile change was performed. The prior broader validation gaps below remain
recorded; readiness is determined by the desktop's independent checks.

The following sections record the earlier repair, before this interaction change.

## Evidence and reproduction

This repair does not claim to reproduce the user's exact remote failure. Read-only
GitHub CLI requests for the account, PR, releases, and Actions runs failed with a
socket access error in this environment. No real release, tag, or workflow was
created, edited, dispatched, or deleted during verification.

Isolated reproductions executed the original workflow's actual Python step bodies
with temporary files and simulated GitHub responses:

- A valid prerelease build failed the stable-only tag expression.
- An app-created, already-public Release failed `Refusing to overwrite a published release`.
- An existing partial draft could not resume uploading its missing assets.
- The app's publisher rejected an exact existing source-only draft instead of
  completing it. Its regression test failed before the fix and passed afterward.

These are demonstrated code defects, not evidence of which one the user encountered.
The observed local dirty-source state is not treated as evidence of the original
failure because this repair itself edits the prepared workspace.

## Changes and prerequisites

- The app can retry repository permission lookup without leaving the release panel.
  Disabled release controls now explain missing source, dirty source, missing local
  versions, and account changes. Source preparation and commit checks remain required.
- Exact source-only drafts and lost create responses are reconciled. Conflicting
  tags or release metadata are never overwritten. Drafts with package assets must
  continue through the package workflow instead of being prematurely published.
- The panel separates Release creation from verified package publication. Its
  explicit package action selects a successful, matching Desktop platforms run,
  checks four nonexpired platform artifacts, and dispatches the publishing workflow.
- The workflow accepts prerelease tags and verifies both project versions against
  the tag. Full package, size, SHA-256, embedded version, and commit checks remain.
- Completing a public Release requires explicit opt-in, supplied by the app's
  package action. Existing metadata and assets must match exactly. Only missing
  assets are uploaded; there is no clobber or deletion. The tag is checked again
  after upload. Prereleases do not become the latest stable release.
- The updated workflow must exist on the repository's default branch for app
  dispatch. Old workflows produce an actionable error. A PR smoke run is not a full
  build: Windows packaging requires a Desktop platforms workflow-dispatch run.
  Existing workflow requirements for nonempty notes are retained.
- Dispatch uses the documented [GitHub workflow API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
  Credentials also need Actions write access; repository write access alone does
  not prove that a restricted token can dispatch workflows.

## Executed verification

- `npm run build` in `ui`: installed TypeScript compiler and Vite passed. Existing
  large-chunk warning remains.
- `node ui/scripts/smoke-release-selection.mjs`: passed in isolated headless Chrome.
  Covers permission recovery, failed-publish retry, package status, both release
  types, version selection, and desktop/mobile layout. GitHub responses are mocked.
- Node release/update regression selection: 76 tests, 74 passed, 1 failed, 1 skipped.
  All 30 release/publishing tests passed. The failure was the existing Windows
  extraction fixture's PowerShell Archive module autoload error. The skipped test
  requires saved/baseline writers unavailable to that test. Neither check was changed.
- `python -m unittest discover -s tests/desktop -p test_publish_workflow.py -v`:
  all 11 tests passed, including complete four-platform fixtures, corrupt archives,
  partial upload retry, metadata conflicts, and the default published-release guard.
- `node --check ui/electron/main.mjs` and `git diff --check`: passed.
- Ruff was unavailable in the installed Python environment; lint validation is pending.

## Data and remaining gaps

No shared persistent format or reader/writer was changed by this repair. New
permission, build-selection, and package-status state is transient. Temporary
request files and test fixtures are isolated and cleaned up. Chats, memories,
configuration, skills, unknown fields, CLEO_HOME, Electron userData, and protected
version-selection/recovery controllers were left unchanged by this repair.

Real account authorization, real Actions runs/artifacts, actual publication and
network recovery, and all frozen manual acceptance cases remain unverified.
Desktop checks determine readiness; these automated tests do not mark manual cases
passed and do not authorize applying or publishing the changes.
