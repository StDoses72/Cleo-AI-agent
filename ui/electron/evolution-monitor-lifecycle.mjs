/** Purpose: Restrict the companion to unavailable Evolution handoffs.
 * Input: registry, main-window heartbeat and current time. Output: show or close, without starting work.
 */
export function monitorDisposition(state, runtime, now = Date.now()) {
  const evolution = Boolean(state.iteration || state.threadId);
  if (!evolution) return "close";
  if (state.transaction) return "show";
  const current = runtime.protocol === 2 && runtime.active === state.active
    && now - (runtime.updatedAt || 0) < 15000;
  if (current && runtime.mainInteractive === true) return "close";
  // A failed handoff remains recoverable until the actual main UI reconnects.
  return "show";
}

/** Purpose: Prevent routine editing/builds from opening a second window.
 * Input: durable registry. Output: whether an Evolution restart is actually in progress.
 */
export function needsEvolutionMonitor(state) {
  return Boolean(state.transaction && (state.iteration || state.threadId));
}
