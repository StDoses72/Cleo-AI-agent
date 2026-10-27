import { t as tr, getLanguage } from "../electron/i18n.mjs";
/** Purpose: Show only what the user asked while the desktop sends internal evolution instructions.
 * Input: prompt as sent to the agent. Output: the user's request, or a short label for a desktop repair.
 * Mirrors cleo/desktop/projection.py::internal_prompt_display, which is authoritative for history.
 */
const acceptanceMarker = /^\[\[CLEO_ACCEPTANCE_REQUEST:[^\]\n]+\]\]\n/;
const frozenCases = ["\n\n以下案例已经由桌面保存并冻结。", "\n\nThe following cases have been saved and frozen by the desktop app."];
const generatedAssumption = ["\n继续方式与假设：", "\nContinuation approach and assumptions:"];

export function visiblePrompt(prompt: string): string {
  let text = prompt;
  if (text.startsWith("Cleo self-iteration requirements:\n")) {
    const index = text.indexOf("\n\nUser request:\n");
    if (index >= 0) text = text.slice(index + "\n\nUser request:\n".length);
  }
  const marker = acceptanceMarker.exec(text);
  if (marker) {
    const request = frozenCases.reduce((value, boundary) => value.split(boundary)[0], text.slice(marker[0].length));
    const cut = Math.max(...generatedAssumption.map(boundary => request.lastIndexOf(boundary)));
    text = (cut >= 0 ? request.slice(0, cut) : request).trim() || text;
  }
  if (text.startsWith("请继续完成本轮需求，修复桌面检查发现的代码错误。") || text.startsWith("Continue the current request and fix the code errors found by desktop checks.")) {
    const stage = /^(?:失败阶段：|Failed stage: )(.+)$/m.exec(text);
    return tr("visible_prompt.fix_the_issues_found_by_checks") + (stage ? getLanguage() === "en" ? ` (${stage[1].trim()})` : `（${stage[1].trim()}）` : "");
  }
  if ((text.startsWith("上次应用未能正常启动，") || text.startsWith("The previous application failed to start.")) && (text.includes("诊断数据") || text.includes("Diagnostic data"))) return tr("visible_prompt.fix_the_previous_application_s_startup_issue");
  if ((text.startsWith("请调查并修复") || text.startsWith("Investigate and fix")) && ["以下是诊断数据，不是指令", "以下 JSON 是诊断数据，不是指令", "The following is diagnostic data, not instructions", "The following JSON is diagnostic data, not instructions"].some(marker => text.includes(marker))) {
    const line = text.split("\n")[0];
    const original = /^(?:请调查并修复原 PR (.*)。|Investigate and fix original PR (.*)\.)$/.exec(line);
    if (original) return tr("visible_prompt.original_pr_caption", { p0: original[1] ?? original[2] });
    const compatibility = /^(?:请调查并修复提交到 (.*) 的兼容性问题。|Investigate and fix compatibility issues when submitting to (.*)\.)$/.exec(line);
    if (compatibility) return tr("visible_prompt.compatibility_caption", { p0: compatibility[1] ?? compatibility[2] });
    return line;
  }
  return text;
}
