import type { ReasoningEffort } from "./types";

export const effortLabels: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高",
  xhigh: "很高", max: "最高", ultra: "极高",
};

export function accessLabel(value: string) {
  return ({ "read-only": "只读", "workspace-write": "工作区可写", "full-access": "完全访问",
    "danger-full-access": "完全访问", default: "由服务管理" } as Record<string, string>)[value] ?? value;
}

export function approvalLabel(value: string) {
  return ({ user: "手动审批", auto_review: "自动审查", deny_all: "拒绝审批请求",
    default: "默认策略", "on-request": "按需审批", untrusted: "审批未信任的操作",
    never: "不发起审批", acceptEdits: "自动允许文件编辑", bypassPermissions: "跳过常规审批",
    auto: "自动审查", auto_allow: "自动允许请求", dontAsk: "拒绝审批请求", plan: "规划模式" } as Record<string, string>)[value] ?? value;
}
