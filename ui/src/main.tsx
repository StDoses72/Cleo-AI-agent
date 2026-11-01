import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { desktopPlatform } from "./platform";
import { cleoClient } from "./services/cleoClient";
import { setLanguage } from "./i18n";
import { LocalConfigPreview } from "./LocalConfigPreview";

document.documentElement.dataset.platform = desktopPlatform;
const localPreview = import.meta.env.DEV && import.meta.env.VITE_CLEO_LOCAL_CONFIG;
createRoot(document.getElementById("root")!).render(
  <StrictMode>{localPreview ? <LocalConfigPreview /> : <App />}</StrictMode>,
);
if (!localPreview) void cleoClient.getUiLanguage().then(setLanguage).catch(error => console.error("Language load:", error));
