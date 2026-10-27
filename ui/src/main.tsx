import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { desktopPlatform } from "./platform";
import { cleoClient } from "./services/cleoClient";
import { setLanguage } from "./i18n";

document.documentElement.dataset.platform = desktopPlatform;

// Preload supplies the saved language while the backend starts; keep loading UI visible.
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
void cleoClient.getUiLanguage().then(setLanguage).catch(error => console.error("Language load:", error));
