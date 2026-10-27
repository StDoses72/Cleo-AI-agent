import { t as tr } from "../../../electron/i18n.mjs";
import type { ModelProfileSummary } from "../../types";

export const accountCheckScope = () => tr("catalog.checks_client_connectivity_sign_in_status_and_the_model_list_only_no_model_request_wa");

export const apiProviders = [
  { id: "openai", name: "OpenAI", mark: "O", provider: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", mark: "A", provider: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "google", name: "Google", mark: "G", provider: "google_genai", baseUrl: "https://generativelanguage.googleapis.com" },
  { id: "deepseek", name: "DeepSeek", mark: "D", provider: "openai", baseUrl: "https://api.deepseek.com" },
  { id: "moonshot", name: "Moonshot", mark: "M", provider: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "custom", get name() { return tr("catalog.custom_provider"); }, mark: "{}", provider: "openai", baseUrl: "" },
];

export const accounts: Record<string, { name: string; mark: string; login: string; billing: string; note: string }> = {
  get codex() { return { name: "Codex", mark: "O", login: tr("catalog.sign_in_with_a_chatgpt_account"), billing: tr("catalog.uses_codex_quota"), note: tr("catalog.sign_in_separately_in_cleo_new_sessions_are_stored_separately_from_codex_app_history_") }; },
  get claude_code() { return { name: "Claude Code", mark: "A", login: tr("catalog.sign_in_with_a_claude_account"), billing: tr("catalog.billed_under_claude_code_rules"), note: tr("catalog.available_quota_for_non_interactive_calls_depends_on_your_current_account_plan") }; },
  get gemini() { return { name: "Gemini CLI", mark: "G", login: tr("catalog.sign_in_with_a_google_account"), billing: tr("catalog.uses_gemini_cli_quota"), note: tr("catalog.use_your_account_s_available_cli_quota_through_the_official_client") }; },
  get copilot() { return { name: "GitHub Copilot", mark: "G", login: tr("catalog.sign_in_with_a_github_account"), billing: tr("catalog.uses_copilot_quota"), note: tr("catalog.available_models_and_usage_depend_on_your_copilot_plan") }; },
  get grok() { return { name: "Grok", mark: "x", login: tr("catalog.sign_in_with_a_grok_account"), billing: tr("catalog.uses_grok_subscription_quota"), note: tr("catalog.use_your_account_s_available_subscription_quota_through_grok_build") }; },
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
  ? accounts[profile.backend!]?.billing || tr("catalog.account_sign_in") : tr("catalog.api_key");
export function modelLabel(id: string) {
  if (id === "default") return tr("catalog.official_default_model");
  if (/^gpt-/i.test(id)) return id.replace(/^gpt-/i, "GPT-").replace(/-(astra|sol|terra|luna)$/i, (_, name: string) => ` ${name[0].toUpperCase()}${name.slice(1)}`);
  return id;
}
