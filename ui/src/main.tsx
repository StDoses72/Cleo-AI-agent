import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { desktopPlatform } from "./platform";
import { LocalConfigPreview } from "./LocalConfigPreview";

document.documentElement.dataset.platform = desktopPlatform;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {import.meta.env.DEV && import.meta.env.VITE_CLEO_LOCAL_CONFIG ? <LocalConfigPreview /> : <App />}
  </StrictMode>,
);
