import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let server;
let ConnectionDetails;
let ConnectionWizard;
const previousWindow = globalThis.window;

before(async () => {
  globalThis.window = { cleoDesktop: {} };
  server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true }, appType: "custom" });
  ({ ConnectionDetails } = await server.ssrLoadModule("/src/components/model-settings/ConnectionDetails.tsx"));
  ({ ConnectionWizard } = await server.ssrLoadModule("/src/components/model-settings/ConnectionWizard.tsx"));
});
after(async () => {
  await server?.close();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

const profile = (backend) => ({ name: "probe", backend, provider: backend === "api" ? "openai" : backend,
  model: "default", models: ["default"], hasApiKey: backend === "api" });
const settings = { activeAgent: "probe", profiles: [] };
const noop = () => {};

for (const backend of ["claude_code", "gemini", "copilot", "grok"]) {
  test(`${backend}: connection success does not imply a verified model turn`, () => {
    const html = renderToStaticMarkup(createElement(ConnectionDetails, {
      profile: profile(backend), settings, busy: false, status: { state: "connected" },
      onStatus: noop, onApply: noop, onReconnect: noop, onClose: noop,
    }));
    assert.match(html, /客户端检查通过/);
    assert.match(html, /未发送模型请求/);
    assert.match(html, /额度及 MCP 工具执行尚未验证/);
  });
}

test("account reconnect retains scope details without a manual verification step", () => {
  const html = renderToStaticMarkup(createElement(ConnectionWizard, {
    existing: profile("claude_code"), settings, busy: false, onApply: noop, onDone: noop,
  }));
  assert.doesNotMatch(html, /已登录，验证连接/);
  assert.match(html, /未发送模型请求/);
});

test("API connection details retain their existing success meaning", () => {
  const html = renderToStaticMarkup(createElement(ConnectionDetails, {
    profile: profile("api"), settings, busy: false, status: { state: "connected" },
    onStatus: noop, onApply: noop, onReconnect: noop, onClose: noop,
  }));
  assert.match(html, /已验证/);
  assert.doesNotMatch(html, /客户端检查通过|未发送模型请求/);
});

test("an unavailable model catalog is not a verified connection or an authentication error", () => {
  const html = renderToStaticMarkup(createElement(ConnectionDetails, {
    profile: profile("api"), settings, busy: false,
    status: { state: "manual", message: "服务未提供模型列表，请手动填写模型 ID。" },
    onStatus: noop, onApply: noop, onReconnect: noop, onClose: noop,
  }));
  assert.match(html, /未验证/);
  assert.match(html, /已配置模型/);
  assert.match(html, /服务未提供模型列表/);
  assert.doesNotMatch(html, /需要检查|已验证/);
});
