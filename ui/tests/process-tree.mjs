export function descendantProcesses(processes, rootPid) {
  const root = processes.find(item => item.ProcessId === rootPid);
  if (!root) return [];
  const descendants = new Map([[rootPid, root]]);
  let added;
  do {
    added = false;
    for (const item of processes) {
      const parent = descendants.get(item.ParentProcessId);
      // Windows retains a dead parent's PID even after that PID is reused.
      if (parent && !descendants.has(item.ProcessId)
        && Date.parse(item.CreationDate) >= Date.parse(parent.CreationDate)) {
        descendants.set(item.ProcessId, item);
        added = true;
      }
    }
  } while (added);
  return [...descendants.values()];
}
