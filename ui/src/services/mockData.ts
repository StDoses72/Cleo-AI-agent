import type {
  ChangeFile,
  MemoryEntry,
  MemoryOverview,
  Project,
  Thread,
  WorkspaceSnapshot,
} from "../types";

const uiChanges: ChangeFile[] = [
  {
    path: "ui/src/App.tsx",
    status: "added",
    additions: 428,
    deletions: 0,
    diff: `@@ -0,0 +1,18 @@
+export function App() {
+  const workspace = useCleoWorkspace();
+
+  return (
+    <div className="app-shell">
+      <WorkspaceRail />
+      <ThreadSidebar />
+      <Conversation />
+      <Inspector />
+    </div>
+  );
+}`,
  },
  {
    path: "ui/src/index.css",
    status: "added",
    additions: 812,
    deletions: 0,
    diff: `@@ -0,0 +1,12 @@
+:root {
+  --canvas: #0b0d10;
+  --surface: #111419;
+  --text: #eef1f5;
+  --muted: #8b929d;
+  --accent: #6be4ed;
+}
+
+.app-shell {
+  display: grid;
+  height: 100vh;
+}`,
  },
  {
    path: "ui/src/services/mockCleoClient.ts",
    status: "added",
    additions: 146,
    deletions: 0,
    diff: `@@ -0,0 +1,10 @@
+export class MockCleoClient implements CleoClient {
+  async *streamTurn(threadId: string, prompt: string) {
+    yield createThinkingEvent(threadId);
+    await delay(640);
+    yield createPlanEvent(prompt);
+    await delay(520);
+    yield createToolEvent("done");
+  }
+}`,
  },
  {
    path: "ui/electron/main.mjs",
    status: "added",
    additions: 58,
    deletions: 0,
    diff: `@@ -0,0 +1,11 @@
+const window = new BrowserWindow({
+  width: 1440,
+  height: 920,
+  minWidth: 980,
+  minHeight: 680,
+  titleBarStyle: "hidden",
+  webPreferences: {
+    contextIsolation: true,
+    nodeIntegration: false,
+    sandbox: true,
+  },
+});`,
  },
];

export const projects: Project[] = [
  {
    id: "cleo-agent",
    space: "productivity",
    name: "Cleo AI agent",
    path: "C:\\Projects\\Cleo-AI-agent",
    branch: "main",
    dirtyFiles: 5,
    accent: "#6be4ed",
    removable: true,
  },
  {
    id: "orbit-notes",
    space: "productivity",
    name: "Orbit Notes",
    path: "D:\\projects\\orbit-notes",
    branch: "feat/sync-engine",
    dirtyFiles: 0,
    accent: "#a78bfa",
    removable: true,
  },
  {
    id: "general",
    space: "chat",
    name: "General",
    path: "memory://general",
    accent: "#f3b768",
  },
];

export const threads: Thread[] = [
  {
    id: "desktop-ui",
    space: "productivity",
    projectId: "cleo-agent",
    title: "完成独立桌面 UI",
    summary: "Electron 前端、mock 数据层与完整交互流程",
    updatedAt: "刚刚",
    status: "completed",
    changes: uiChanges,
    usage: { used: 38420, limit: 128000, input: 6320, output: 4418 },
    items: [
      {
        id: "user-desktop",
        type: "message",
        role: "user",
        content:
          "距离好用就差一点了。我需要完整的 UI，前端参照 T3 Code，但先不要和后端结合；另外不要做成 Web UI，要做成独立应用。",
        time: "16:38",
      },
      {
        id: "thought-desktop",
        type: "thought",
        content: "梳理 Cleo 的 session、harness、memory 与 runtime 边界",
        status: "done",
      },
      {
        id: "plan-desktop",
        type: "plan",
        title: "实现计划",
        steps: [
          { label: "确认桌面产品结构与视觉方向", status: "done" },
          { label: "建立 Electron 与 mock client 边界", status: "done" },
          { label: "完成会话、变更、记忆和设置界面", status: "done" },
          { label: "启动应用并完成体验验收", status: "running" },
        ],
      },
      {
        id: "tool-desktop",
        type: "tool",
        name: "workspace",
        command: "npm run build",
        status: "done",
        output: "renderer built · electron entry ready · 0 type errors",
      },
      {
        id: "notice-desktop",
        type: "notice",
        tone: "success",
        title: "独立桌面体验版已就绪",
        detail: "当前使用本地 mock runtime；消息、工具、计划与变更均可交互。",
      },
      {
        id: "assistant-desktop",
        type: "message",
        role: "assistant",
        content:
          "第一版桌面工作区已经成形。界面层只依赖 CleoClient 协议，当前实现是可流式返回事件的 mock client。后续接入 Python 后端时，只需要新增 IPC bridge，不会改动消息流、侧栏或检查器组件。你可以先新建一个任务，完整体验发送、执行、工具展开和变更查看。",
        time: "16:47",
      },
    ],
  },
  {
    id: "session-hub",
    space: "productivity",
    projectId: "cleo-agent",
    title: "统一 managed 与 native sessions",
    summary: "检查 SessionHub 的恢复与去重路径",
    updatedAt: "今天 14:22",
    status: "attention",
    changes: [],
    usage: { used: 21980, limit: 128000, input: 4810, output: 3091 },
    items: [
      {
        id: "user-session",
        type: "message",
        role: "user",
        content: "检查 managed 和 native thread 合并后是否还会重复。",
        time: "14:04",
      },
      {
        id: "assistant-session",
        type: "message",
        role: "assistant",
        content: "我确认了聚合层按 native id 去重，但恢复失败时缺少明确的可恢复提示。下一步建议补一条针对 provider history 不可用的回归测试。",
        time: "14:22",
      },
    ],
  },
  {
    id: "limits",
    space: "productivity",
    projectId: "cleo-agent",
    title: "修正 Codex 用量显示",
    summary: "统一 5 小时和每周额度的状态投影",
    updatedAt: "昨天",
    status: "completed",
    changes: [],
    usage: { used: 8870, limit: 128000, input: 1900, output: 1102 },
    items: [
      {
        id: "assistant-limits",
        type: "message",
        role: "assistant",
        content: "用量栏现在优先显示账户限额，SDK 没有返回限额时才回退到上下文窗口，避免把两种百分比混在一起。",
        time: "昨天 18:10",
      },
    ],
  },
  {
    id: "weekly-plan",
    space: "chat",
    projectId: "general",
    title: "这周真正重要的三件事",
    summary: "收束 UI、稳定 session、安排一次完整体验",
    updatedAt: "今天 09:10",
    status: "idle",
    changes: [],
    usage: { used: 5260, limit: 128000, input: 1210, output: 870 },
    items: [
      {
        id: "user-plan",
        type: "message",
        role: "user",
        content: "我这周事情很多，帮我把注意力收回来。",
        time: "09:02",
      },
      {
        id: "assistant-plan",
        type: "message",
        role: "assistant",
        content:
          "先只守住三件事：把 Cleo 的桌面体验做完整；把 session 恢复路径跑通；留一段不被打断的时间亲自使用它。其他事情先放进停车场，不需要同时推进。",
        time: "09:10",
      },
    ],
  },
  {
    id: "product-tone",
    space: "chat",
    projectId: "general",
    title: "Cleo 的产品语气",
    summary: "聪明、克制、有温度，但不表演亲密",
    updatedAt: "周六",
    status: "idle",
    changes: [],
    usage: { used: 9030, limit: 128000, input: 2130, output: 1340 },
    items: [
      {
        id: "assistant-tone",
        type: "message",
        role: "assistant",
        content: "Cleo 不应该像客服，也不应该像一层套在模型外面的吉祥物。她需要准确理解上下文，在需要的时候给出判断，其他时候安静地把工作做好。",
        time: "周六 22:18",
      },
    ],
  },
];

export const memories: MemoryEntry[] = [
  {
    id: "pref-desktop",
    scope: "preference",
    title: "偏好独立桌面应用",
    content: "体验型 UI 应以独立应用交付，不把浏览器页面当作最终产品表面。",
    source: "完成独立桌面 UI",
    updatedAt: "刚刚",
  },
  {
    id: "project-local-first",
    scope: "project",
    title: "Cleo 是 local-first runtime",
    content: "配置、session event log、项目记忆、persona 和 workspace 均由本地目录管理。",
    source: "Cleo AI agent / MEMORY.md",
    updatedAt: "昨天",
  },
  {
    id: "project-boundaries",
    scope: "project",
    title: "两类空间严格分离",
    content: "non_productivity 与 productivity 分区存储；全局 persona 是唯一跨空间投影。",
    source: "Architecture review",
    updatedAt: "3 天前",
  },
  {
    id: "persona-style",
    scope: "persona",
    title: "交流方式",
    content: "直接、自然、有判断力。先给结果，再说明关键依据；避免过度格式化和空泛鼓励。",
    source: "PERSONA.md",
    updatedAt: "5 天前",
  },
];

export const memoryOverview: MemoryOverview = {
  schema_version: 1,
  summary: {
    active_memories: memories.length,
    project_memories: 3,
    project_scopes: 2,
    persona_traits: 1,
    pending_sources: 2,
  },
  dream_agent: {
    status: "attention",
    last_processed_at: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
    pending_count: 1,
    running_count: 0,
    failed_count: 1,
  },
  project_summaries: [
    { space: "productivity", project: "Cleo-AI-agent", memory_count: 2, updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
    { space: "non_productivity", project: "general", memory_count: 1, updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
  ],
  review_sources: [
    {
      id: "productivity:Cleo-AI-agent:desktop-ui",
      space: "productivity",
      project: "Cleo-AI-agent",
      session_id: "desktop-ui",
      status: "pending",
      source_version: 3,
      last_event_seq: 28,
      failure_count: 0,
      last_error: null,
      updated_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    },
    {
      id: "non_productivity:general:product-tone",
      space: "non_productivity",
      project: "general",
      session_id: "product-tone",
      status: "failed",
      source_version: 2,
      last_event_seq: 11,
      failure_count: 1,
      last_error: "模型请求在整理完成前中断，可以重新运行。",
      updated_at: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
    },
  ],
  entries: [
    {
      id: "pref-desktop",
      scope: "project",
      space: "non_productivity",
      project: "general",
      category: "preference",
      title: "偏好独立桌面应用",
      content: "体验型 UI 应以独立应用交付，不把浏览器页面当作最终产品表面。",
      confidence: 0.98,
      importance: 5,
      tags: ["desktop", "product"],
      evidence: [{ space: "non_productivity", project: "general", session_id: "desktop-ui", event_id: "user-desktop", observed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }],
      evidence_count: 1,
      updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    },
    {
      id: "project-local-first",
      scope: "project",
      space: "productivity",
      project: "Cleo-AI-agent",
      category: "decision",
      title: "Cleo 是 local-first runtime",
      content: "配置、session event log、项目记忆、persona 和 workspace 均由本地目录管理。",
      confidence: 0.96,
      importance: 5,
      tags: ["architecture", "local-first"],
      evidence: [{ space: "productivity", project: "Cleo-AI-agent", session_id: "desktop-ui", event_id: "assistant-desktop", observed_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }],
      evidence_count: 1,
      updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "project-boundaries",
      scope: "project",
      space: "productivity",
      project: "Cleo-AI-agent",
      category: "constraint",
      title: "两类空间严格分离",
      content: "non_productivity 与 productivity 分区存储；全局 persona 是唯一跨空间投影。",
      confidence: 0.94,
      importance: 4,
      tags: ["memory", "isolation"],
      evidence: [{ space: "productivity", project: "Cleo-AI-agent", session_id: "session-hub", event_id: "assistant-session", observed_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() }],
      evidence_count: 1,
      updated_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "persona-style",
      scope: "persona",
      space: null,
      project: null,
      category: "communication",
      title: "交流方式",
      content: "直接、自然、有判断力。先给结果，再说明关键依据；避免过度格式化和空泛鼓励。",
      confidence: 0.9,
      importance: 4,
      tags: ["style"],
      evidence: [],
      evidence_count: 2,
      updated_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
};

export const snapshot: WorkspaceSnapshot = {
  projects,
  threads,
  memories,
  memoryOverview,
  runtime: {
    provider: "Codex",
    model: "gpt-5.5",
    effort: "high",
    access: "workspace-write",
    approval: "按需确认",
  },
};

export { uiChanges };
