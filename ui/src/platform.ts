export const desktopPlatform = window.cleoWindow?.platform
  ?? (navigator.platform.toLowerCase().includes("mac") ? "darwin" : "unknown");

export const modifierKey = desktopPlatform === "darwin" ? "⌘" : "Ctrl";
