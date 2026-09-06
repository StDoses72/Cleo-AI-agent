import type { CleoClient } from "../types";
import { IpcCleoClient } from "./ipcCleoClient";
import { MockCleoClient } from "./mockCleoClient";

export const cleoClient: CleoClient = window.cleoDesktop
  ? new IpcCleoClient()
  : new MockCleoClient();
