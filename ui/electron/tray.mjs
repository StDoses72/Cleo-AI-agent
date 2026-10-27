import { t as tr } from "./i18n.mjs";
/** Keep the main window and its running work alive until an explicit application quit. */
export function createTrayController({ app, Menu, Tray, nativeImage, iconPath, createWindow,
  canOpen = () => true, onOpenMemory,
  onError = error => console.error("Cleo tray:", error.message), platform = process.platform }) {
  let window = null;
  let tray = null;
  let started = false;
  let quitting = false;

  const getWindow = () => window && !window.isDestroyed() ? window : null;
  const show = () => {
    if (!started || quitting || !canOpen()) return null;
    const current = getWindow();
    if (!current) return createWindow();
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
    return current;
  };
  const destroyTray = () => {
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  };
  const refreshLanguage = () => {
    if (!tray || tray.isDestroyed()) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: tr("tray.open_cleo"), click: show },
      ...(onOpenMemory ? [{ label: tr("tray.memory_management"), click: () => {
        const current = show();
        if (current) onOpenMemory(current);
      } }] : []),
      { type: "separator" },
      { label: tr("tray.quit_cleo"), click: () => app.quit() },
    ]));
  };
  app.on("before-quit", () => {
    if (quitting) return;
    quitting = true;
  });
  app.once("will-quit", destroyTray);
  app.on("activate", show);
  app.on("window-all-closed", () => {
    if (platform !== "darwin" && (!tray || tray.isDestroyed())) app.quit();
  });

  return {
    refreshLanguage,
    getWindow,
    show,
    isVisible: () => Boolean(getWindow()?.isVisible()),
    isQuitting: () => quitting,
    start() {
      if (started || quitting) return;
      started = true;
      try {
        const image = nativeImage.createFromPath(iconPath);
        if (image.isEmpty()) throw new Error(tr("tray.cleo_tray_icon_not_found"));
        tray = new Tray(image.resize({ height: platform === "darwin" ? 18 : 24 }));
        tray.setToolTip("Cleo");
        refreshLanguage();
        tray.on("click", show);
        tray.on("double-click", show);
      } catch (error) {
        destroyTray();
        onError(error);
      }
    },
    attachWindow(current) {
      window = current;
      current.on("close", event => {
        if (quitting || !tray || tray.isDestroyed()) return;
        event.preventDefault();
        current.hide();
      });
      current.on("query-session-end", () => {
        // Start normal cleanup without delaying Windows shutdown or log-off.
        app.quit();
      });
      current.once("closed", () => {
        if (window === current) window = null;
      });
    },
  };
}
