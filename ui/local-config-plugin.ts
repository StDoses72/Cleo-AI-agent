import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const methods = new Set([
  "get_model_settings", "get_routing_settings", "save_routing_settings", "refresh_routing_benchmarks",
  "save_benchmark_connection", "submit_routing_feedback",
  "get_task_usage_preview",
]);

/** Purpose: Connect a loopback Vite preview to settings-only Python RPC. Output: dev plugin. */
export function localConfigPlugin(python: string | undefined): Plugin {
  return {
    name: "cleo-local-config", apply: "serve",
    configureServer(server) {
      if (!python) return;
      if (server.config.server.host !== "127.0.0.1") throw new Error("Local configuration preview requires host 127.0.0.1");
      if (!process.env.CLEO_HOME || !process.env.CLEO_CONFIG_PATH || !process.env.CLEO_HARNESSES_CONFIG_PATH) {
        throw new Error("Local configuration preview requires explicit CLEO_HOME, CLEO_CONFIG_PATH and CLEO_HARNESSES_CONFIG_PATH");
      }
      const token = randomBytes(32).toString("hex");
      let child: ChildProcessWithoutNullStreams | undefined;
      let sequence = 0;
      const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      /** Purpose: Fail outstanding calls without exposing backend diagnostics. Input: none. */
      const unavailable = () => {
        child = undefined;
        for (const item of pending.values()) {
          clearTimeout(item.timer); item.reject(new Error("本地配置服务不可用，请检查预览启动配置。"));
        }
        pending.clear();
      };
      /** Purpose: Lazily start the restricted backend. Output: child stdin/stdout transport. */
      const backend = () => {
        if (child) return child;
        const running = spawn(python, ["-X", "utf8", "-m", "cleo.desktop.local_config"], {
          cwd: new URL("..", import.meta.url), windowsHide: true,
          env: { ...process.env, PYTHONPATH: fileURLToPath(new URL("..", import.meta.url)), PYTHONUNBUFFERED: "1" },
        });
        child = running;
        const failed = () => { if (child === running) unavailable(); };
        running.on("error", failed); running.on("exit", failed); running.stdin.on("error", failed);
        // Vendor diagnostics may contain credentials. Never forward stderr to the browser/log.
        running.stderr.resume();
        createInterface({ input: running.stdout }).on("line", line => {
          try {
            const message = JSON.parse(line);
            const item = pending.get(message.id);
            if (!item || message.type === "event") return;
            clearTimeout(item.timer); pending.delete(message.id);
            if (message.type === "error") item.reject(new Error("配置读取或保存失败。配置可能已被其他窗口修改，请重新加载后重试。"));
            else item.resolve(message.result);
          } catch { /* Ignore vendor output that is not protocol JSON. */ }
        });
        return running;
      };
      /** Purpose: Send one allowlisted request. Input: method/params. Output: RPC result. */
      const request = (method: string, params: Record<string, unknown>) => {
        const process = backend();
        const id = String(++sequence);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id); reject(new Error("本地配置服务响应超时，请重新加载。"));
          }, 90_000);
          pending.set(id, { resolve, reject, timer });
          process.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => {
            if (error) unavailable();
          });
        });
      };
      /** Purpose: Return private JSON. Input: status/body. Output: no-store HTTP response. */
      const reply = (res: ServerResponse, status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(JSON.stringify(body));
      };
      /** Purpose: Bound incoming JSON. Input: HTTP request. Output: parsed request body. */
      const readBody = async (req: IncomingMessage) => {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 128_000) throw new Error("请求过大。");
        }
        return JSON.parse(body);
      };
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__cleo_config/")) return next();
        const address = server.httpServer?.address();
        const host = address && typeof address === "object" ? `127.0.0.1:${address.port}` : "";
        if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)
            || req.headers["sec-fetch-site"] === "cross-site") return reply(res, 403, { error: "仅允许本地同源访问。" });
        if (req.url === "/__cleo_config/session" && req.method === "GET") return reply(res, 200, { token });
        if (req.url !== "/__cleo_config/rpc" || req.method !== "POST"
            || req.headers["x-cleo-preview"] !== token
            || !req.headers["content-type"]?.startsWith("application/json")) return reply(res, 403, { error: "无效的本地配置请求。" });
        try {
          const { method, params = {} } = await readBody(req);
          if (!methods.has(method) || !params || typeof params !== "object" || Array.isArray(params)) return reply(res, 403, { error: "此预览只支持配置读取和路由保存，不支持推理执行。" });
          reply(res, 200, { result: await request(method, params) });
        } catch (error) { reply(res, 400, { error: error instanceof Error ? error.message : "本地配置请求失败。" }); }
      });
      server.httpServer?.once("close", () => {
        child?.stdin.end(); child?.kill(); unavailable();
      });
    },
  };
}
