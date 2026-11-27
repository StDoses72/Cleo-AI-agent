import { translator } from "../electron/i18n.mjs";

/** Purpose: The message that runs a workflow in a conversation. `/workflow <id> <task>` starts a
 * saved workflow on a task; `/workflow retry` resumes the conversation's last run. */
export function workflowCommand(prompt: string): { target: string; task: string } | null {
  const match = /^\/workflow\s+(\S+)\s*([\s\S]*)$/.exec(prompt.trim());
  return match ? { target: match[1], task: match[2].trim() } : null;
}

/** The skill that writes a workflow from what the user describes; "Ask AI" starts a conversation with it. */
export const CREATE_WORKFLOW_SKILL = "/create-workflow";

/** What the user asked that skill for: the prompt without the skill's name and without the line
 * the app opens it with, in whichever language that line was written. `null` for any other prompt. */
export function workflowNeeds(prompt: string): string | null {
  if (!prompt.startsWith(CREATE_WORKFLOW_SKILL)) return null;
  const said = prompt.slice(CREATE_WORKFLOW_SKILL.length).trim();
  const opening = (["zh-CN", "en"] as const).map((language) => translator(language)("workflows.ask_prompt")).find((line) => said.startsWith(line));
  return (opening ? said.slice(opening.length) : said).trim();
}
