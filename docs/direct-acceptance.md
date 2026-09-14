# Direct acceptance after application

Users can now click 验收 after applying and experiencing a build, without writing
an observation or sending feedback. Applying alone does not confirm a case.
Feedback remains optional and is used when behavior needs further improvement.
Stale/unapplied builds and superseded cases still cannot be completed.

The observation input and its required-state checks were removed. Backend review
and completion accept omitted/empty notes. Empty notes stay empty; no generated
text claims a specific observation. A previously written manual observation is
retained when completing that already-reviewed item without another note.

## Storage compatibility

The affected stores are `acceptance/suite.json`, `acceptance/report.json` and
`acceptance/interactions-v1.json`. Formats, field names and types remain unchanged.
`detail` and `note` remain strings, including the empty string. Completion still
records the real confirmation timestamp and applied build/source identifiers.
`requests-v1.json`, chats, memories, configuration, skills and Electron profile
storage were not changed. There is no migration.

The compatibility script ran against isolated fixtures using the pre-edit source
snapshot and retained program readers/writers:

- Pre-edit iteration source: passed.
- `local-0db9d67a-ef81-47a3-9c9d-8788910d979d`: passed.
- `local-f6ab5739-d41d-4599-8be1-1e08e258025a`: passed.
- `baseline-8f73451a-b184-4ce3-835c-5cab78ff34a9`: unverified; it has no acceptance
  reader/writer. Existing formats remain unchanged.

The old → new → old → new round trip included omitted optional fields, unknown
fields, nonempty legacy evidence, empty-note confirmations, old request writes,
old interaction writes where available, and nonempty chat/memory/configuration
sentinels. Stable IDs and current data were retained. Temporary source copies
were removed after the checks; no live user stores were used.

## Verification

- Installed TypeScript: `tsc -b --force --pretty false` passed.
- Vite production build passed, with its existing large-chunk warning.
- Acceptance, requests, interactions and behavior-policy suites: 31 passed.
- Isolated Chrome UI test passed: no observation field, direct confirmation with
  no feedback, feedback then confirmation of revised criteria, persisted state
  after reload, and no invented observation text. Existing skill checks also ran.

Tests requiring an empty-note rejection were updated for the explicitly requested
optional-note behavior. Their build-binding, stale-result and explicit-confirmation
assertions remain, and note preservation and direct-click coverage were added.
No check command or frozen human acceptance expectation was removed or weakened.

These are automated fixture results, not passes for the frozen manual cases.
The desktop still performs its own checks. No apply, restart, save-version or
publish action was performed.
