import { IpcCleoClient } from "./ipcCleoClient";
import { MockCleoClient } from "./mockCleoClient";

export const cleoClient = window.cleoDesktop
  ? new IpcCleoClient()
  : new MockCleoClient();
