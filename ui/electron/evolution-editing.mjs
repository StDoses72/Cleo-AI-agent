/** The desktop, not an agent's prose or renderer lifecycle, decides when editing may build. */
export async function runPreparedEvolutionTurn({ evolution, requests, acceptance, backend, params, onEvent }) {
  const id = await evolution.operation("checking", () => requests.claim(params.thread_id, params.prompt));
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
    await evolution.operation("checking", () => requests.finish(id, succeeded ? "completed" : "interrupted"));
  }
  if (succeeded) {
    const candidate = await evolution.build();
    if (candidate) await evolution.operation("checking", () => acceptance.compare(candidate));
  }
  return result;
}
