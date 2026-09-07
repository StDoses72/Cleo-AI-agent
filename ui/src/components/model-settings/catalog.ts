import type { ModelProfileSummary } from "../../types";

export const apiProviders = [
  { id: "openai", name: "OpenAI", mark: "O", provider: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", mark: "A", provider: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "google", name: "Google", mark: "G", provider: "google_genai", baseUrl: "https://generativelanguage.googleapis.com" },
  { id: "deepseek", name: "DeepSeek", mark: "D", provider: "openai", baseUrl: "https://api.deepseek.com" },
  { id: "moonshot", name: "Moonshot", mark: "M", provider: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "custom", name: "自定义服务", mark: "{}", provider: "openai", baseUrl: "" },
];

export const accounts: Record<string, { name: string; mark: string; login: string; billing: string; note: string }> = {
  codex: { name: "Codex", mark: "O", login: "使用 ChatGPT 账号登录", billing: "使用 Codex 额度", note: "与 Codex 共用用量，不会使用 ChatGPT 普通 Chat 的聊天额度。" },
  claude_code: { name: "Claude Code", mark: "A", login: "使用 Claude 账号登录", billing: "按 Claude Code 规则计费", note: "非交互调用的可用额度，以账号当前方案为准。" },
  gemini: { name: "Gemini CLI", mark: "G", login: "使用 Google 账号登录", billing: "使用 Gemini CLI 配额", note: "通过官方客户端使用账号可用的 CLI 配额。" },
  copilot: { name: "GitHub Copilot", mark: "G", login: "使用 GitHub 账号登录", billing: "使用 Copilot 配额", note: "可用模型及用量按你的 Copilot 方案计算。" },
  grok: { name: "Grok", mark: "x", login: "使用 Grok 账号登录", billing: "使用 Grok 订阅额度", note: "通过 Grok Build 使用账号可用的订阅额度。" },
};

export const profileLabel = (profile: ModelProfileSummary) => profile.displayName || profile.name;
export const profileModels = (profile: ModelProfileSummary) => [...new Set([profile.model, ...(profile.models || [])])];
export const isAccount = (profile: ModelProfileSummary) => !!profile.backend && profile.backend !== "api";
export function providerInfo(profile: ModelProfileSummary) {
  if (isAccount(profile)) return accounts[profile.backend!] || { name: profile.provider, mark: "·" };
  return apiProviders.find(item => item.baseUrl && profile.baseUrl?.replace(/\/$/, "") === item.baseUrl)
    || apiProviders.find(item => item.provider === profile.provider) || apiProviders[5];
}
export const billingLabel = (profile: ModelProfileSummary) => isAccount(profile)
  ? accounts[profile.backend!]?.billing || "账号登录" : "API 密钥";
export function modelLabel(id: string) {
  if (id === "default") return "官方默认模型";
  if (/^gpt-/i.test(id)) return id.replace(/^gpt-/i, "GPT-").replace(/-(astra|sol|terra|luna)$/i, (_, name: string) => ` ${name[0].toUpperCase()}${name.slice(1)}`);
  return id;
}
