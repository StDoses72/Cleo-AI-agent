# Cleo contribution targets

The contribution dialog offers two explicit actions:

- Submit a PR from the signed-in user's fork to an existing upstream branch.
- Submit a GitHub Issue applying for a target branch. An owner/collaborator creates the branch independently. Refresh verifies its existence; a separate user action then submits the PR.

Neither action creates an upstream Git ref or merges a PR. `main` is excluded from the UI and rejected by the backend, including qualified `refs/heads/main`, surrounding whitespace, and case variants. Missing targets have no default. Git validates all requested branch names.

Both actions pin a local build ID. PR submission verifies the live source hash equals that build's hash before committing or pushing. A branch application retains that version during cleanup so it remains available while waiting. To submit a different saved version, first select it in the version picker and prepare its source.

Branch applications and PRs retain stable IDs across retries, reconcile remote receipts after response loss, and reject changes to an existing attempt's content/target/version. PRs use independent fork branches without forced pushes. GitHub Issues must be enabled and accessible to submit an application; an API or permission error remains visible and does not imply success.

An abandoned evolution request retains its prompt, error, and evidence with `abandonedAt`; further retries are rejected. Its remaining manual cases are cancelled, not passed. The desktop clears the active request and its retry callback so a new request can start independently. Existing code changes are retained; discarding code remains the separate version action.

Validation: `node --test ui/tests/evolution-submit.test.mjs ui/tests/evolution-store.test.mjs ui/electron/evolution-requests.test.mjs`. The submission tests use real local Git repositories and an intercepted GitHub boundary, including a maintainer-created target, version pinning, response loss, and rejected non-fast-forward pushes. `ui/tests/acceptance-retry.smoke.mjs` exercises the built UI, including the original preparation error, abandonment, both contribution paths, and main prohibition. No public Issues or PRs are created by these checks.
