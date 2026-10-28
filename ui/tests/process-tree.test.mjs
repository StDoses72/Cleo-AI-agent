import assert from "node:assert/strict";
import test from "node:test";
import { descendantProcesses } from "./process-tree.mjs";

test("process ownership excludes older processes whose parent PID was reused", () => {
  const processes = [
    { ProcessId: 3, ParentProcessId: 2, Name: "python.exe", CreationDate: "2026-10-28T18:01:02Z" },
    { ProcessId: 5, ParentProcessId: 2, Name: "dwm.exe", CreationDate: "2026-10-28T17:00:00Z" },
    { ProcessId: 1, ParentProcessId: 9, Name: "Cleo.exe", CreationDate: "2026-10-28T18:00:00Z" },
    { ProcessId: 4, ParentProcessId: 1, Name: "csrss.exe", CreationDate: "2026-10-28T17:00:00Z" },
    { ProcessId: 2, ParentProcessId: 1, Name: "cmd.exe", CreationDate: "2026-10-28T18:01:00Z" },
  ];
  assert.deepEqual(descendantProcesses(processes, 1).map(item => item.ProcessId).sort(), [1, 2, 3]);
  assert.deepEqual(descendantProcesses(processes, 99), []);
});
