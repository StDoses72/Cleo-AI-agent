# Non-Codex harness investigation — 2026-09-14

## Desktop regression repair — request 87f58eb8-7a98-4605-b176-b372535985eb

The desktop reported two failures in `tests/scripts/test_uninstall.py`: Python's
UTF-8 pipe reader failed on localized Windows PowerShell error bytes. This repair
only defines the uninstaller's output encoding and the test caller's matching
strict decoder. Removal paths, link/marker guards, process checks and all existing
assertions remain unchanged; no live installation or user data was used.

- Reproduced before fixing: an inherited CP936 console caused `UnicodeDecodeError`;
  CP1252 replaced the fixture's Chinese path with `??`.
- `scripts/uninstall.ps1` now sets console output to UTF-8 before any validation can
  throw. The subprocess test helper explicitly decodes UTF-8 with strict errors.
- Added two code-page regressions asserting the rejection, readable Unicode path
  and unchanged fixture contents. Existing test expectations were retained.
- Full uninstaller module after fixing: **5 passed, 4 failed**. The two desktop
  failures and both new regressions passed; the four remaining local failures are
  `Get-CimInstance Win32_Process` access denied by this execution environment.
  Process discovery was not bypassed and those tests were not skipped or weakened.
- The two original failures and two new encoding regressions also passed with
  parent `PYTHONUTF8=0` and subprocess-reader thread warnings treated as errors,
  confirming the boundary no longer depends on Python's locale default.
- Installed TypeScript compiler (`tsc -b --force --pretty false`), six related UI
  tests, Ruff for the changed Python test, and `git diff --check` passed.
- Final desktop revalidation remains authoritative. The original five manual
  harness cases remain unverified as described below.

Acceptance request: `3c16411c-2d05-46fc-bdce-16d1936cef1d`.
The five frozen desktop cases were not edited or marked passed. Backend probes and
automated regressions below are not manual desktop acceptance results.

## Findings and changes

- Chat `claude_code` uses the configured official CLI. `auth status` and model
  discovery do not send a model prompt. The actual probe returned exit 0,
  `loggedIn=true`, `authMethod=claude.ai`; full connection inspection returned
  `connected` and five models. Installed CLI: **2.1.223**.
- Task `claude` uses `ClaudeProvider` and **claude-agent-sdk 0.2.152**, whose bundled
  CLI is **2.1.259**. Its session, permissions, tools and CLI are separate from the
  chat connection. Passing chat validation does not validate this task path.
- The old chat adapter discarded stderr and collapsed nonzero exit, missing result
  and error result into the same login/quota/MCP suggestion. It now reports the
  observed exit code, result state/subtype, Cleo MCP initialization status when
  present, malformed stream status, and bounded redacted error details. It drains
  all stderr while retaining at most 16 KiB in memory; it does not save raw logs.
  Early stdin closure no longer masks the CLI's eventual failure result.
- Chat now retains a returned native session ID for subsequent prompts on the same
  provider session. Previously the second prompt launched without `--resume`.
- SDK tool results arrive in `UserMessage` blocks. They were silently ignored;
  they now reach both the event callback and the returned turn. SDK terminal and
  MCP connection errors also redact credential-bearing diagnostic text.
- Account connection screens now say “客户端检查通过” and explicitly state that no
  model request was sent and quota/MCP execution remain unverified. API connection
  wording retains its prior meaning.
- ACP presets, permission policy and storage behavior are unchanged. No evidence
  supported loosening permissions or changing CLI flags. Regression coverage checks
  tool events, consecutive turns and allow/reject behavior using protocol fixtures.

## Actual runtime evidence and remaining gaps

| Frozen case | Evidence gathered | Still unverified |
| --- | --- | --- |
| `4a2da817-2e75-4034-a76b-708af2b9033e` Claude turn failure | Original provider probe timed out. A 35-second CLI probe observed system init, failed MCP, repeated `api_retry`, and no result. Its exit 1 followed probe termination and is **not** the original fault's exit code. With isolated writable Cleo data, MCP connected but the model still retried (`error=unknown`) until the 35-second probe deadline. | Screenshot incident's original exit code/result/stderr were not retained by the old implementation. Its exact cause cannot be established. No successful real reply or desktop manual retest. The deadline is a probe limit, not a new production timeout. |
| `0988b552-5604-4a43-b1bf-6955d480db8e` Connection scope | Same selected chat profile passed login and model discovery; subsequent actual model request did not complete within the probe deadline. Six rendered UI tests validate the scope wording. | Real desktop comparison after applying the change remains pending. |
| `2ff5595c-b3ed-45a4-a7bd-13486ede3410` Claude MCP | In the restricted execution environment, starting chat tools against live data failed with `sqlite3.OperationalError: unable to open database file` during existing session-store initialization. No persistence workaround was applied. With disposable configuration/data, actual stdio MCP discovered **20 tools**, read `probe.txt`, and returned `CLEO_MCP_OK`. Claude also reported `cleo-tools=connected` with isolated data. | An LLM-directed tool call and final reply could not be exercised because the preceding model request did not finish. Direct MCP success is not proof of a completed model turn. |
| `5e3b3213-3024-4108-ad29-e74e30bc6d6a` Task SDK | Real SDK session creation, including its required fixture memory MCP connection, succeeded. First model request exceeded the 35-second probe deadline. SDK tool-result forwarding is covered by a failing-before/passing-after regression. | Real task reply, second turn, resume and desktop display remain pending. No CLI outcome was attributed to the SDK path. |
| `eaba0fde-0ebc-43e3-a31e-8065a5718871` Other harnesses | Gemini/Copilot/Grok commands are absent on PATH and have no enabled chat profiles. Their built-in task presets are available. OpenCode is absent and its existing task configuration is disabled. No enabled custom non-Codex harness was found. ACP fixture tests cover all four names plus a custom name. | Installation/authentication/version, actual prompts/tools/continuation and manual acceptance for these absent runtimes. No installation, enablement or credential change was performed. |

The environment restricts outbound network access. Model probes provided retries
or timeout, not an authoritative quota/login/API error; this report does not infer
a specific account problem from those signals.

## Verification

- Before fixes, `tests/integrations/test_non_codex_regressions.py` produced **5
  failures**: three erased diagnostic branches, missing CLI continuation, and
  omitted SDK tool result. Those regressions subsequently passed.
- Python suite: `tests/integrations`, `tests/agents/test_subscription_runtime.py`,
  `tests/desktop/test_subscription_login.py`, and
  `tests/desktop/test_task_harness_selection.py`: **139 passed, 1 skipped**, plus
  9 subtests. The existing skipped test requires opt-in `CLEO_TEST_CODEX_BIN`.
  Existing MCP annotation deprecation warning remains. After the final lint cleanup,
  the 14 new regressions were rerun and passed. Ruff checks passed for all changed
  Python implementation and test files.
- The suite ran using the installed Cleo Python and cached pytest dependencies,
  with disposable configuration/data and fixtures outside the repository. Earlier
  runs exposed environment contamination: live SQLite access was denied; a fixture
  under the checkout inherited the checkout's Git repository; inherited
  `CLEO_CODEX_BIN` changed an unrelated mocked Codex assertion. Isolating fixtures
  and removing that desktop override in the test process resolved these without
  changing or skipping checks.
- Installed TypeScript compiler: `node node_modules/typescript/bin/tsc -b` passed.
- UI: `node --test tests/model-connection-scope.test.mjs`: **6 passed**.
- Production frontend compilation: `node node_modules/vite/bin/vite.js build`
  passed; the existing >500 KiB chunk advisory remains.
- `tests/manual/probe_non_codex.py mcp|cli|sdk` is an opt-in backend probe using
  disposable Cleo configuration, project and data. Only the probe child overrides
  its Cleo paths; it retains the existing vendor login. It never marks acceptance
  cases, applies versions, or controls the desktop. `mcp` passed; `cli` and `sdk`
  reported blocked/timeout as described above.

Cleanup limitation: automatic approval rejected recursive deletion, including a
second attempt limited to three explicitly resolved temporary directories, with
`blocked by policy`. No further cleanup was attempted. Generated artifacts remain
at `tests/.diagnostic-deps/`, `tests/.uv-cache/`,
`tests/.tmp-noncodex-red/`, `tests/.tmp-noncodex-green/`, and
`tests/.tmp-noncodex-isolated/`. The first transport probe, whose transport omitted
the Cleo environment, also generated a placeholder `config/cleo.json` under this
checkout; it is not the active user configuration. Later probe directories and the
final isolated suite's temporary home were removed by their normal context-manager
cleanup. Installed UI dependencies and build output remain in ignored
`ui/node_modules/` and `ui/dist/`.

## Data and recovery boundaries

No persistence readers, writers, schemas, defaults or migrations were changed.
No old data snapshots were restored and no storage compatibility claim is based on
program rollback. Production `CLEO_HOME`, Electron `userData`, chats, memories,
configuration, skills, IDs and unknown fields retain their existing behavior.
Previous/saved-version format round trips are not applicable to this change: the
shared format is unchanged. Temporary test stores were used for all test writes.
The protected version selector and recovery controller were not modified. Cleo was
not quit, restarted, applied, saved as a version, or published.

## Protocol references

- [Claude CLI reference](https://code.claude.com/docs/en/cli-usage): print-mode
  streaming, MCP configuration and tool flags. Existing flags were retained.
- [Official SDK cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-04-migrating-from-openai-agents-sdk):
  `UserMessage` carries tool-result blocks; verified against installed SDK classes
  and the regression stream.
