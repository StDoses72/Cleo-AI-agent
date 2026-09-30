/** Keep every quit request behind the same complete shutdown of application writers. */
export function createQuitBarrier({ close, quit, onError }) {
  let complete = false;
  let pending = null;
  return event => {
    if (complete) return;
    event.preventDefault();
    if (pending) return pending;

    // Set the barrier before invoking closers: a closer can synchronously request quit again.
    const completion = Promise.withResolvers();
    pending = completion.promise;
    const operations = close.map(closer => {
      try { return Promise.resolve(closer()); }
      catch (error) { return Promise.reject(error); }
    });
    void Promise.allSettled(operations).then(results => {
      try {
        for (const result of results) if (result.status === "rejected") onError(result.reason);
      } finally {
        complete = true;
        quit();
      }
    }).then(completion.resolve, completion.reject);
    return pending;
  };
}
