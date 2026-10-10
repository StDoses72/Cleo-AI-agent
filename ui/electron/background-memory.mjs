/** Poll the backend's persisted schedule without depending on a visible renderer. */
export function createBackgroundMemoryScheduler({ backend, canRun, onError, intervalMs = 30_000 }) {
  let timer = null;
  let stopped = false;
  let pending = false;

  const tick = async () => {
    if (stopped || pending || !backend.process) return;
    pending = true;
    try {
      if (canRun()) await backend.request("run_background_memory_review");
      else await backend.request("cancel_background_memory_review");
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      pending = false;
    }
  };

  return {
    start() {
      if (stopped || timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
    },
  };
}
