// The real app against the real backend: a saved workflow is started from the library, runs
// through a scripted ACP harness, and shows as one card with a session per node.
// Needs the backend's Python environment (CLEO_TEST_PYTHON, default ../.venv/bin/python) and,
// on Linux without a display, xvfb-run with ELECTRON_DISABLE_SANDBOX=1.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const ui = resolve(import.meta.dirname, "..");
const repository = resolve(ui, "..");
const python = process.env.CLEO_TEST_PYTHON ?? join(repository, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const root = mkdtempSync(join(tmpdir(), "cleo-workflows-backend-"));

// The same isolated home and scripted harness the backend's own scenario tests use.
execFileSync(python, ["-c", `
import json, sys
from pathlib import Path
from tests.characterization.support.home import build_home
from tests.characterization.test_workflows import _workflow
home = build_home(Path(sys.argv[1]), "http://127.0.0.1:9/v1")
flows = home.home / "data" / "workflows"
flows.mkdir(parents=True)
definition = _workflow()
for index, node in enumerate(definition["nodes"]):
    node.update(x=48, y=120 + index * 104)
definition["start"], definition["end"] = {"x": 120, "y": 48}, {"x": 120, "y": 340}
(flows / "wf-two-steps.json").write_text(json.dumps(definition), encoding="utf-8")
(Path(sys.argv[1]) / "env.json").write_text(json.dumps(home.env()), encoding="utf-8")
`, root], { cwd: repository });

const app = await electron.launch({ args: [".", `--user-data-dir=${join(root, "electron")}`], cwd: ui,
  env: { ...process.env, ...JSON.parse(readFileSync(join(root, "env.json"), "utf8")), CLEO_PYTHON: python } });
const page = await app.firstWindow();
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 920));
  await page.getByTestId("open-workflows").click({ timeout: 60_000 });
  const tile = page.getByTestId("workflow-card").filter({ hasText: "Two steps" });
  await tile.waitFor({ timeout: 60_000 });
  assert.equal(await tile.locator(".wf-flag").count(), 0, "The scripted harness's models were read, so nothing is flagged");

  // The canvas offers the harness that exists and what a node on it can be held to.
  await tile.locator(".wf-tile-open").click();
  await page.locator('[data-testid="workflow-node"]', { hasText: "Planner" }).click();
  const detail = page.getByTestId("node-detail");
  assert.ok(await detail.locator('[data-field="harness"] option[value="scripted"]').count());
  await page.getByTestId("workflow-back").click();

  await tile.getByTestId("workflow-card-run").click();
  await page.getByTestId("workflow-chip").waitFor({ timeout: 15_000 });
  await page.getByTestId("composer-input").fill("ship the export");
  await page.getByTestId("send-button").click();
  await page.getByTestId("workflow-run-card").waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="workflow-run-status"]')?.dataset.status;
    return status && status !== "running";
  }, null, { timeout: 120_000 });
  assert.equal(await page.getByTestId("workflow-run-status").first().getAttribute("data-status"), "completed");
  assert.deepEqual(await page.locator(".wf-run-strip li").evaluateAll((items) => items.map((item) => item.dataset.status)), ["done", "done"]);
  assert.equal(await page.getByTestId("workflow-run-card").count(), 1);
  await page.getByText("From Planner:").first().waitFor();

  // Each node's session is listed under the conversation and opens without a composer.
  await page.getByTestId("node-sessions-toggle").click();
  const sessions = page.getByTestId("subtask-row");
  assert.equal(await sessions.count(), 2);
  await sessions.filter({ hasText: "Planner" }).locator(".thread-row-select").click();
  await page.getByTestId("subtask-parent").waitFor();
  await page.getByText("You are the Planner.").first().waitFor();
  assert.equal(await page.getByTestId("composer-input").count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", realBackend: true, nodeSessions: 2 }));
} finally {
  await app.close();
}
