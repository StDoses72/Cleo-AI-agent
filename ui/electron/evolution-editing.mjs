/** An unchanged build still needs acceptance against the version already running. */
export function compareBuiltVersion(evolution, acceptance, candidate) {
  return evolution.operation("comparing", async () => {
    const target = candidate ?? (await acceptance.store.read()).active;
    return acceptance.compare(target);
  });
}

/** The desktop, not an agent's prose or renderer lifecycle, decides when editing may build. */
export async function runPreparedEvolutionTurn({ evolution, requests, acceptance, backend, params, onEvent }) {
  const id = await evolution.operation("validating", () => requests.claim(params.thread_id, params.prompt));
  let completed = false;
  let failed = false;
  let succeeded = false;
  let result;
  try {
    await evolution.begin();
    result = await backend.request("stream_turn", params, (event) => {
      if (event.type === "done") completed = true;
      if (event.type === "error") failed = true;
      onEvent(event);
    });
    succeeded = completed && !failed;
  } finally {
    await evolution.operation("validating", () => requests.finish(id, succeeded ? "completed" : "interrupted"));
  }
  if (succeeded) {
    const candidate = await evolution.build();
    await compareBuiltVersion(evolution, acceptance, candidate);
  }
  return result;
}
/** Purpose: Run a normal coding conversation in the dedicated source workspace.
 * Input: selected harness and user turn. Output: editable changes, with explicit build kept separate.
 */
export async function runEvolutionTurn({ evolution, backend, params, onEvent }) {
  await evolution.begin();
  await evolution.recordValidation({ status: "pending", message: "可以继续补充需求；准备体验时点击检查改动。" });
  return backend.request("stream_turn", params, onEvent);
}
