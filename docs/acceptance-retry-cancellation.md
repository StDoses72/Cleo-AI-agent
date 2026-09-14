# Request retries and optional human acceptance

A preparation failure after opening a new evolution task retained the request ID but
retried through the original React render's task selection. That could create a
second task and fail the durable request identity check. The retry callback now
captures the resolved task before preparing the request. Identity checks remain in place.

Manual acceptance cases now offer **取消此项验收** without requiring a candidate,
comparison or successful build. Cancellation archives the original evidence with a
timestamp, never creates a passing result, and does not cancel automatic regressions.
Unrelated fresh results are preserved; stale results remain stale.

**继续修改** accepts optional feedback and reuses the same frozen case and original
task. It does not run the planner or multiply acceptance cases. Current saved builds
can also be compared and manually accepted when no candidate exists. Draft source
changes still prevent comparison until built.

Validation from `ui`:

```powershell
node --test electron/evolution-acceptance.test.mjs electron/evolution-requests.test.mjs tests/evolution-interactions.test.mjs tests/evolution-behavior-policy.test.mjs tests/evolution-retry.test.mjs
npm run build
$env:CLEO_TEST_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node tests/acceptance-retry.smoke.mjs
```

The browser smoke exercises the real App with an isolated desktop bridge and the
real acceptance/request stores. It does not contact a model or GitHub, change live
acceptance records, or establish that any user behavior case has passed.
