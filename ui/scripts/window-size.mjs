const boundPages = new WeakSet();

/** Wait for both the native window and renderer after the OS applies size limits. */
export async function resizeWindow(application, page, requested) {
  if (!boundPages.has(page)) {
    await page.exposeFunction("__cleoNativeWindowSize", () => application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { bounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor() };
    }));
    boundPages.add(page);
  }
  await application.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isMaximized()) window.unmaximize();
    window.setContentSize(width, height);
    window.webContents.setZoomFactor(zoom);
  }, requested);
  await page.waitForFunction(async ({ width, height, zoom }) => {
    const current = await window.__cleoNativeWindowSize();
    return current.bounds.width >= width - 4 && current.bounds.width <= width + 4
      && current.bounds.height >= height - 60 && current.bounds.height <= height + 4
      && Math.abs(current.zoom - zoom) < 0.001
      && Math.abs(innerWidth - current.bounds.width / zoom) <= 4
      && Math.abs(innerHeight - current.bounds.height / zoom) <= 4;
  }, requested);
  return page.evaluate(() => window.__cleoNativeWindowSize());
}
