import assert from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron as electron } from 'playwright';

const output = resolve(process.env.CLEO_SMOKE_OUTPUT);
const python = process.env.CLEO_PYTHON;
assert(python, 'Run this test inside the Python dependency environment');
await copyFile(resolve('../cleo/config/templates/cleo.example.json'), join(output, 'cleo.json'));
await copyFile(resolve('../cleo/config/templates/harnesses.example.json'), join(output, 'harnesses.json'));
const app = await electron.launch({ args: ['.', `--user-data-dir=${join(output, 'electron-profile')}`],
  cwd: resolve('.'), env: { ...process.env, CLEO_PYTHON: python,
    CLEO_HOME: join(output, 'app-home'), CLEO_CONFIG_PATH: join(output, 'cleo.json'),
    CLEO_HARNESSES_CONFIG_PATH: join(output, 'harnesses.json') } });
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.showInactive(); });
  page.setDefaultTimeout(30000);
  await page.waitForFunction(() => !!window.cleoDesktop?.computerDesktop);
  const state = await page.evaluate(() => window.cleoDesktop.computerDesktop());
  assert.equal(state.phase, 'ready');
  if (!(await page.locator('.inspector-tabs').count())) {
    await page.getByRole('button', { name: /^(打开检查器|查看代码变更)$/ }).click();
  }
  await page.locator('.inspector-tabs').getByRole('button', { name: '电脑', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-connected="true"] canvas')?.width === 1440);
  await page.screenshot({ path: join(output, 'electron-independent-desktop.png') });
  console.log('NATIVE_DESKTOP_IPC_PASSED: production UI, preload, backend, guest, VNC, CSP');
} finally { await app.close(); }
