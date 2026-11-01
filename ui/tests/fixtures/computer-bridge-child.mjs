import { ComputerBridge } from "../../electron/computer/bridge.mjs";

// Purpose: Simulate a second desktop publisher. Input: isolated directory. Output: IPC readiness.
const bridge = new ComputerBridge({ directory: process.argv[2], protect: () => {},
  handler: async () => [{ type: "text", text: "secondary" }] });
await bridge.start();
process.send({ ready: true });
