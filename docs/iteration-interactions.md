# Skill completion and continuing behavioral acceptance

This change adds keyboard/click slash completion, a read-only skill catalog for new
task drafts, case-specific feedback, explicit completion and a single optional
requirements confirmation with a skip action. Frozen criteria are never edited:
feedback creates linked new criteria, preserving the old record. Automatic
regressions remain enabled. A human case exits the pending list only after an
applied-build observation is recorded with a durable completion receipt.

The Composer inserts a selected command without sending it. Native composition
events and key code 229 guard submission. Catalog requests are scoped to the
selected provider and project; stale asynchronous results are discarded.
Claude connections explicitly load user and project setting sources. Codex keeps
its existing native discovery configuration, working directory and environment.
Automatic usage is left to each harness's native discovery and invocation rules;
the selectable catalog does not govern automatic usage or claim it happened.
See [Claude SDK skill discovery](https://code.claude.com/docs/en/agent-sdk/skills)
and [OpenAI skill documentation](https://learn.chatgpt.com/docs/build-skills).

## Persistence and compatibility

Affected stores under `acceptance/`:

- `suite.json`: unchanged field names/types/meanings; revised items get new IDs.
  Previous human items retain their full content and use the existing disabled
  state when replaced or explicitly completed.
- `report.json`: existing result format and build/source binding. Feedback makes
  an old human pass pending again. Completion preserves unrelated results.
- `requests-v1.json`: unchanged schema and existing optional `replaces`, `answer`
  and `clarifications` fields. Old requests and unknown fields are retained.
- `interactions-v1.json`: separate additive storage for feedback, skip decisions
  and completion receipts. Older writers do not own this file. Unknown fields
  are preserved; unreadable/newer data is rejected without overwriting it.

No chat, memory, configuration, skill files, `CLEO_HOME`, Electron `userData`,
version selector or recovery controller were changed. Backups or program rollback
are not evidence of data compatibility.

`node ui/scripts/check-acceptance-compatibility.mjs ../builds tests/.tmp-iteration-base`
ran against temporary fixtures using actual readers/writers from the pre-edit
iteration snapshot and both retained local bundles:

- `local-e4a1775e-dae5-428f-93ca-f92f0340653a`: passed.
- `local-f6ab5739-d41d-4599-8be1-1e08e258025a`: passed.
- Pre-edit iteration snapshot: passed.
- `baseline-8f73451a-b184-4ce3-835c-5cab78ff34a9`: unverified because it has no
  acceptance reader/writer. Existing shared formats remain unchanged; new
  interaction data is separate. This does not claim the baseline has this feature.

Round trips covered old data → new read/write → old read/write → new read,
including old request `finish`, suite create/archive, compare/review, new feedback
and completion, missing `sourceThread`, unknown top-level/nested fields, stable
IDs, nonempty evidence and separate nonempty chat/memory/configuration sentinels.
No fixture operation used live user data. The temporary pre-edit code snapshot
was removed after verification; pass results above record that completed run.

## Checks actually run

- Installed TypeScript compiler: `node node_modules/typescript/bin/tsc -b` passed.
- The UI fixture also passed `tsc -p tests/tsconfig.interactions.json`.
- Production Vite build passed; existing >500 kB chunk warning remains.
- Acceptance, request orchestration, interaction, behavior-policy and atomic-JSON
  tests: 34 passed, including draft-skill IPC registration.
- `tests/desktop/check_skills.py`: passed with the bundled Python runtime.
- `tests/desktop/check_iteration_interactions.py`: passed, checking the actual
  Claude options constructor with a fake client, draft discovery, and the planner's
  source-grounded assumption output. No real model call was made.
- `ui/tests/interaction-ui.smoke.mjs`: passed in local headless Chrome using
  isolated real acceptance/request storage and a mocked analyzer. Covers prefix
  filtering, no matches, deletion, composition, keyboard/click selection, switching
  catalogs, arguments, feedback, skip, revised expectation, completion and reload.
  Screenshots are in `ui/output/playwright/interactions/`.
- All eight protected controller hashes matched `protected.json`.

Remaining validation gaps/failures:

- Existing `ui/scripts/smoke-evolution-preparation.mjs:146` failed: it expects
  Apply to be disabled for pending manual cases. The existing behavior-policy
  regression explicitly permits Apply before human observation; the requested
  post-Apply acceptance flow relies on that behavior. Neither expectation nor
  controller checks were weakened to conceal the disagreement.
- The broad `ui/tests/evolution-*.test.mjs` invocation stopped producing output
  and was interrupted. It is not reported as passed. Focused affected suites
  subsequently completed successfully.
- pytest is not installed in the available Python runtimes. The existing pytest
  suites were not run; the two dependency-free checks above are reported only for
  what they actually exercised.
- Real harness automatic invocation, native OS IME behavior and packaged Electron
  execution still need desktop/manual validation. The frozen human cases have not
  been marked passed. The desktop decides readiness through its independent checks.

No apply, save-version, publish, quit or restart operation was performed.
