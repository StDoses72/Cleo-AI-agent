# Requirements and acceptance

[中文](evolution-acceptance-preparation.md) | [Documentation](README.en.md)

When an evolution session receives a change request, it saves the original text and request ID, reads relevant source, and freezes acceptance cases. Clear requests proceed to implementation; ambiguities that affect implementation prompt clarification. Cases contain requirements, source evidence, actions, expected behavior, and a verification method.

## From request to application

1. Describe the change and clarify any open requirements.
2. Cleo implements the frozen cases, then compiles, builds, checks regressions, and packages the program.
3. Apply the build after checks pass and try the actions described in each case.
4. Click Acceptance (验收), give feedback, continue editing, or cancel a case. Notes are optional.

Build checks and human acceptance are separate. Users confirm ordinary interaction cases; Dream-format cases can be replayed with isolated data. Changes to cases, source, or builds invalidate earlier results.

## Resume and revise

Requests, clarifications, cases, execution state, and failure details persist across reloads and restarts. Submitted editing tasks are not automatically sent again. Retry preparation on the original request, or continue an interrupted implementation with its existing cases.

Revise case (修正案例) changes the actions, expected outcome, and reason. The original case is archived and the revision gets a new ID. A plain question receives an answer in the same session without starting an edit or build.

See [local evolution](cleo-evolution.en.md), [direct acceptance](direct-acceptance.en.md), and [retries and cancellation](acceptance-retry-cancellation.en.md).
