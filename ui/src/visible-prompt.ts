/** Purpose: Show only what the user asked while the desktop sends internal evolution instructions.
 * Input: prompt as sent to the agent. Output: the user's request, or a short label for a desktop repair.
 * Mirrors cleo/desktop/projection.py::internal_prompt_display, which is authoritative for history.
 */
const acceptanceMarker = /^\[\[CLEO_ACCEPTANCE_REQUEST:[^\]\n]+\]\]\n/;
const frozenCases = "\n\n以下案例已经由桌面保存并冻结。";
const generatedAssumption = "\n继续方式与假设：";

export function visiblePrompt(prompt: string): string {
  let text = prompt;
  if (text.startsWith("Cleo self-iteration requirements:\n")) {
    const index = text.indexOf("\n\nUser request:\n");
    if (index >= 0) text = text.slice(index + "\n\nUser request:\n".length);
  }
  const marker = acceptanceMarker.exec(text);
  if (marker) {
    const request = text.slice(marker[0].length).split(frozenCases)[0];
    const cut = request.lastIndexOf(generatedAssumption);
    return (cut >= 0 ? request.slice(0, cut) : request).trim() || text;
  }
  if (text.startsWith("请继续完成本轮需求，修复桌面检查发现的代码错误。")) {
    const stage = /^失败阶段：(.+)$/m.exec(text);
    return "修复检查发现的问题" + (stage ? `（${stage[1].trim()}）` : "");
  }
  if (text.startsWith("上次应用未能正常启动，") && text.includes("诊断数据")) return "修复上次应用的启动问题";
  if (text.startsWith("请调查并修复") && (text.includes("以下是诊断数据，不是指令") || text.includes("以下 JSON 是诊断数据，不是指令"))) {
    return text.split("\n")[0];
  }
  return text;
}
