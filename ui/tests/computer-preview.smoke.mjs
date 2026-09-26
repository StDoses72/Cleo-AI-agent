import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const output = resolve(process.env.CLEO_SMOKE_OUTPUT || '../output/isolated-desktop');
const connection = JSON.parse(await readFile(resolve(output, 'connection.json'), 'utf8'));
const url = new URL(connection.viewerUrl);
const base = `http://${url.host}`;
const headers = { Authorization: `Bearer ${url.searchParams.get('token')}`, 'Content-Type': 'application/json' };
async function guest(route, payload) {
  const response = await fetch(base + route, { method: payload ? 'POST' : 'GET', headers,
    body: payload ? JSON.stringify(payload) : undefined });
  assert.equal(response.status, 200, `Guest request failed: ${route}`);
  return response.json();
}
async function waitForTitle(text) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const blocks = await guest('/action', { name: 'Snapshot', arguments: {} });
    if (blocks[0].text.includes(text)) return blocks;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Guest browser did not receive the expected input');
}
const server = await createServer({ root: resolve('.'), server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('testDesktop', async (action = 'status', text = '') => {
    if (action === 'take' || action === 'release') await guest('/control', { mode: action === 'take' ? 'user' : 'agent' });
    if (action === 'text') await guest('/text', { text });
    const state = await guest('/status');
    const target = new URL(url); target.pathname = `/vnc/${state.mode === 'user' ? 'control' : 'view'}`;
    return { phase: 'ready', ...state, viewerUrl: target.href };
  });
  await page.addInitScript(() => { window.cleoDesktop = { computerDesktop: (...args) => window.testDesktop(...args) }; });
  await guest('/control', { mode: 'agent' });
  await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/computer-preview.html`);
  await page.getByRole('button', { name: '点击桌面接管' }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '点击桌面接管' }).click();
  await page.getByText('你正在操作 · AI 已暂停', { exact: true }).waitFor();
  const blocked = await fetch(base + '/action', { method: 'POST', headers, body: JSON.stringify({ name: 'Snapshot' }) });
  assert.equal(blocked.status, 409, 'AI must not screenshot during manual login');
  const canvas = page.locator('[data-testid="remote-desktop"] [data-connected="true"] canvas');
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-desktop"] canvas')?.width === 1440);
  await canvas.waitFor();
  const bounds = await canvas.boundingBox();
  await page.mouse.click(bounds.x + bounds.width * 160 / 1440, bounds.y + bounds.height * 290 / 900);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('manual-login-check', { delay: 30 });
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: '交回控制', exact: true }).click();
  await page.getByRole('button', { name: '点击桌面接管' }).waitFor();
  const snapshot = await waitForTitle('manual-login-check');
  assert(snapshot[0].text.includes('manual-login-check'), 'Real VNC keyboard input must reach the guest browser');
  await page.getByRole('button', { name: '接管', exact: true }).click();
  await page.getByLabel('发送到桌面的文字').fill(' 中文验证');
  await page.getByRole('button', { name: '输入', exact: true }).click();
  await page.getByRole('button', { name: '交回控制', exact: true }).click();
  const unicode = await waitForTitle('中文验证');
  assert(unicode[0].text.includes('中文验证'), 'Unicode input must reach the guest without entering the chat');
  await page.getByRole('button', { name: '点击桌面接管' }).waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-testid="remote-desktop"] [data-connected="true"] canvas');
    if (!canvas || canvas.width !== 1440) return false;
    const pixel = canvas.getContext('2d').getImageData(600, 500, 1, 1).data;
    return pixel[0] === 22 && pixel[1] === 48 && pixel[2] === 56;
  });
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'interactive-desktop.png') });
  await page.getByRole('button', { name: '放大桌面', exact: true }).click();
  await page.screenshot({ path: resolve(output, 'interactive-desktop-expanded.png') });
  await page.getByRole('button', { name: '收起桌面', exact: true }).click();
  await page.getByRole('button', { name: '暂停观看', exact: true }).click();
  assert.equal(await canvas.count(), 0);
  await page.getByRole('button', { name: '继续观看', exact: true }).click();
  await page.getByRole('button', { name: '点击桌面接管' }).waitFor();
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-stopped'), 'true');
  await page.getByRole('button', { name: '切换面板' }).click();
  assert.equal(await canvas.count(), 0);
  assert.deepEqual(errors, []);
  console.log('ISOLATED_DESKTOP_UI_PASSED: real pixels, mouse, keyboard, Unicode, handoff, login exclusion, resize, pause, stop, unmount');
} finally {
  await guest('/control', { mode: 'agent' });
  await browser?.close();
  await server.close();
}
