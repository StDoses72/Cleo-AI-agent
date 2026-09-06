import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../ui/node_modules/playwright/index.mjs";
import { TARGETS } from "../site/targets.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const types = { html: "text/html", css: "text/css", mjs: "text/javascript", png: "image/png" };
export function serveDownloadPage() {
  const server = createServer(async (request, response) => {
    const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
    if (!/^[\w.-]+$/.test(name)) { response.writeHead(404).end(); return; }
    try {
      const path = name === "cleo.png" ? join(root, "ui/public/cleo.png") : join(root, "download/site", name);
      const data = await readFile(path);
      response.writeHead(200, { "content-type": types[name.split(".").at(-1)] || "text/plain" }).end(data);
    } catch { response.writeHead(404).end(); }
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

const server = await serveDownloadPage();
const url = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes("--serve")) {
  console.log(url);
} else {
  const browser = await chromium.launch({ channel: process.env.CLEO_BROWSER_CHANNEL });
  const release = { tag_name: "v0.3.0", assets: Object.values(TARGETS).flatMap(({ file, checksum }) => [
    { name: file, size: 500_000_000 }, { name: checksum, size: 90 },
  ]) };
  try {
    for (const [name, platform, hints, expected] of [
      ["Windows", "Win32", { platform: "Windows", architecture: "x86", bitness: "64" }, "windows-x64"],
      ["Mac ARM", "MacIntel", { platform: "macOS", architecture: "arm", bitness: "64" }, "macos-arm64"],
      ["Mac Intel", "MacIntel", { platform: "macOS", architecture: "x86", bitness: "64" }, "macos-x64"],
      ["Safari without hints", "MacIntel", null, ""],
      ["Linux", "Linux x86_64", { platform: "Linux", architecture: "x86", bitness: "64" }, "linux-x64"],
      ["unsupported Windows ARM", "Win32", { platform: "Windows", architecture: "arm", bitness: "64" }, ""],
    ]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(({ platform, hints }) => {
        Object.defineProperty(navigator, "platform", { value: platform });
        Object.defineProperty(navigator, "userAgentData", { value: hints ? {
          ...hints, getHighEntropyValues: async () => hints,
        } : undefined });
      }, { platform, hints });
      await context.route("https://api.github.com/**", (route) => route.fulfill({ json: release }));
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector("#version").textContent.includes("v0.3.0"));
      assert.equal(await page.locator("#target").inputValue(), expected, name);
      assert.equal(await page.locator("#download").getAttribute("aria-disabled"), String(!expected), name);
      if (name === "Windows" && process.env.CLEO_DOWNLOAD_DESKTOP_SCREENSHOT) {
        await page.screenshot({ path: process.env.CLEO_DOWNLOAD_DESKTOP_SCREENSHOT, fullPage: true });
      }
      await page.locator("#target").selectOption("macos-arm64");
      assert.match(await page.locator("#download").getAttribute("href"), /\/v0.3.0\/Cleo-macos-arm64.zip$/);
      assert.match(await page.locator("#install-note").textContent(), /尚未通过 Apple 公证/);
      await page.locator("#target").selectOption("linux-deb");
      assert.match(await page.locator("#checksum").getAttribute("href"), /Cleo-linux-x64.deb.sha256$/);
      assert.deepEqual(errors, [], name);
      await context.close();
    }
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("https://api.github.com/**", (route) => route.abort());
    await page.goto(url);
    await page.locator("#target").selectOption("windows-x64");
    await page.waitForFunction(() => document.querySelector("#release-status").textContent.length > 0);
    assert.match(await page.locator("#download").getAttribute("href"), /\/latest\/download\/Cleo-windows-x64.zip$/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.CLEO_DOWNLOAD_SCREENSHOT) await page.screenshot({ path: process.env.CLEO_DOWNLOAD_SCREENSHOT, fullPage: true });
    console.log("Download page browser checks passed: 6 platform cases, manual selection, offline fallback, mobile layout.");
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
}
