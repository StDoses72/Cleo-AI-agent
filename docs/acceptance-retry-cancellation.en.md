# Request retries and cancellation

[中文](acceptance-retry-cancellation.md) | [Documentation](README.en.md)

If preparation fails, Retry original request (重试准备原需求) reuses the task and request record instead of creating another task.

Cancel this acceptance case (取消此项验收) is available without a candidate build. It preserves evidence and a cancellation timestamp, does not mark the case as passed, and does not cancel automatic regression checks.

Continue editing (继续修改) accepts optional feedback and reuses the frozen case and original task. Saved versions can also be compared and accepted; build outstanding source changes before comparison.

See [requirements and acceptance](evolution-acceptance-preparation.en.md) and [direct acceptance](direct-acceptance.en.md).
