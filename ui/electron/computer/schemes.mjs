/** File-preview privileges must be registered before Electron emits ready. */
export const FILE_SCHEME = "cleo-file";
const registeredProtocols = new WeakSet();

/** Purpose: Register file-preview privileges once, before startup awaits.
 * Input: Electron's protocol API. Output: Registration; later calls are harmless.
 */
export function registerComputerSchemes(protocol) {
  if (registeredProtocols.has(protocol)) return;
  protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: {
    standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false,
  } }]);
  registeredProtocols.add(protocol);
}
