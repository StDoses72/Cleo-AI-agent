# Source contributions

[中文](contribution-targets.md) | [Documentation](README.en.md)

Contribute a checked local version from Cleo through an independent source snapshot PR. Maintainers decide when to merge and publish it.

## Choose a receiving branch

The contribution dialog supports submitting a PR to an existing receiving branch or creating a GitHub Issue requesting a new one.

For a branch request, a maintainer uses Create a branch → Source: `submission-base` to create the named empty branch. Do not add a README or other files. Refresh the branch list in Cleo and select it. `main` and `submission-base` itself cannot be selected as targets.

Creating an application does not create the branch or submit the PR. GitHub Issues must be enabled and accessible. Each receiving branch is used once; after it receives a snapshot, create a new empty branch for another submission.

## Submit a version

1. Select the local build you want to contribute. For another saved version, select it in the version picker and prepare its source.
2. Connect GitHub and choose the empty receiving branch.
3. Enter the PR title and description, then submit.
4. Follow the returned PR link or refresh its status from contribution history.

Cleo verifies that the current source matches the checked build, pins the target SHA, and verifies that its tree is empty. It exports a full program source snapshot into a separate temporary repository, retaining file bytes and tracked executable permissions. Local configuration, conversations, runtime data, and build outputs are excluded.

The snapshot commit has the target SHA as its only parent and is pushed to an independent branch in your fork. It does not commit or alter your development checkout or index. Target changes or source mismatches stop submission. No force push or automatic final merge is performed.

## Retry and history

Each attempt keeps a stable ID and selected build. Retries reconcile GitHub state before creating anything again; unfinished submissions retain the pinned snapshot. Changing an existing attempt's content, target, or version requires a new attempt. Older unfinished submissions based on development history must be restarted through the snapshot flow.

Branch applications retain their selected version while waiting. Abandoning an evolution request preserves its evidence and cancels its pending manual cases; discarding source changes is a separate action.

## Merge assistance

Help merge / Refresh status (帮助合并 / 刷新状态) reads the PR's current branches, commits, checks, merge status, and source permissions. It can investigate conflicts in a temporary copy.

Investigate and repair original PR (调查并修复原 PR) starts the existing requirements and acceptance workflow tied to that PR and source branch. It aims to retain both sides' features and update the original branch without force pushing after checks. Decisions requiring human judgment are presented for review.

Branch state can change after inspection. Final merging remains subject to GitHub checks, reviews, permissions, and maintainer action. Existing PR history is not automatically rewritten into snapshot history.
