import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { desktopPlatform } from "./platform";
import { StylePicker, applyStyle, initialStyle } from "./components/StylePicker";

document.documentElement.dataset.platform = desktopPlatform;
applyStyle(initialStyle());

// The style switcher is a review aid for the browser preview; the desktop build never shows it.
const reviewMode = !window.cleoDesktop;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {reviewMode && <StylePicker />}
  </StrictMode>,
);
