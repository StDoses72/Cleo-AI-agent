import { createRequire } from "node:module";
import { registerComputerSchemes } from "./schemes.mjs";

/** Purpose: Initialize file-preview privileges on Electron's synchronous startup path.
 * Input: Runtime version and an injectable Electron loader. Output: Once-only registration.
 * Plain Node path helpers and tests do not load Electron's executable-path shim.
 */
export function initializeComputerStartup({ electronVersion = process.versions.electron,
  loadElectron = () => createRequire(import.meta.url)("electron") } = {}) {
  if (!electronVersion) return;
  registerComputerSchemes(loadElectron().protocol);
}
