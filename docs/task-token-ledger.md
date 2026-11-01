# Current task usage

The first request starts a task. Related follow-ups, corrections, delegated workers and
independent evaluator calls continue its ledger. A different goal starts a new ledger after
the configured evaluator confirms the boundary. Failure/uncertainty keeps the current task;
it never relabels the entire session as the current task. Old history remains in storage.

The v0.10.0 subscription adapter accepts the native provider’s approval/client parameters
while retaining deny-all approvals and its existing tool scope. The configured evaluator
uses the new-dialog default when unset and never changes the selected session main model.
Cancellation propagates with cleanup; no automatic paid probe or replay is performed.
Safe error categories distinguish transport incompatibility, model rejection and bad output.

## Compact panel

Only the active task abstract, reported total tokens, and each model’s calls/turns,
responsibility, tokens and reference USD are displayed. Native notification updates are not
counted as separate inference calls. Missing usage remains unknown. Previous failed boundary
records remain historical facts until a later classification succeeds.

USD is an offline comparison at standard input/output token rates from configured prices
or exact version/effort benchmark bindings in the local catalog and AA cache. Viewing usage
never refreshes AA or calls a model. Missing/ambiguous prices or input/output telemetry yield
unknown USD, not zero. Cache discounts/premiums, subscriptions and tax are excluded: reference
USD is not an invoice. Price timestamps remain available in the model row tooltip.

## Local sidebar

The existing opt-in loopback preview opens on Task usage, alongside real Connections and
Subtask routing settings. Its get_task_usage_preview RPC reads an existing tracked user
session’s active ledger only. It returns no event history, raw prompts or historical tasks,
and cannot create a session, execute a turn or select an arbitrary session outside its list.
Use Re-read to load changes made in the native client. Real settings remain shared.

Offline tests patch SDK transport before process creation and exercise the real evaluator
configuration seam. The preview HTTP/browser integration uses an isolated fixture home and
blocks external browser requests. Offline success does not establish online model availability.

## Compact usage and routing controls

The inspector shows the active goal only: semantic title, reported token total, model
responsibilities/calls/tokens and USD. Missing telemetry is retained as unknown and disclosed
in hover details; it is never inferred from prompt length or replayed. A coordinator can call
`label_current_task` during its normal work; no dedicated title model call is scheduled.
Until a semantic title is available, the panel says "当前任务" rather than copying the request.

Context capacity comes from the selected model's local runtime metadata, including the
runtime's effective capacity percentage when present, or its configured catalog capacity.
`max_tokens` limits generation and is not used as a context capacity. Native notifications
supersede metadata. Model changes clear the old occupancy; unknown capacities show a dash.

USD prefers reliable harness-reported cost, then exact calibrated input/output/cache rates.
Subscription amounts remain API-equivalent amounts, with their basis available on hover.
Unknown rates or missing cache prices are never shown as zero. Prices from mutable aliases
are not guessed. Historical token records are not rewritten or backfilled using inference.

The routing model pool is searchable and grouped by connection/model. Effort variants stay
in advanced controls, preserving exclusions and the server's availability checks. AA data
status separates key configuration, cache freshness and selected-model coverage. Exact
matches and family references remain distinct; missing mappings can be calibrated explicitly.
A configured key alone does not prove a successful refresh or online model access.

For sequential work, `delegate_subtask` accepts optional `handoff` with a predecessor
`task_id`, bounded `summary`, and relative `artifacts`. The host requires completed work
from the same parent and current goal, rejects failed acceptance and paths outside the
workspace, and records only predecessor/paths/acceptance, not the summary or file contents.
The coordinator owns decomposition, ordering, acceptance and the final answer. AA rankings
are references, not a guarantee of globally minimal tokens, price or latency.
