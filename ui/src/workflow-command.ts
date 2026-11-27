/** Purpose: The message that runs a workflow in a conversation. `/workflow <id> <task>` starts a
 * saved workflow on a task; `/workflow retry` resumes the conversation's last run. */
export function workflowCommand(prompt: string): { target: string; task: string } | null {
  const match = /^\/workflow\s+(\S+)\s*([\s\S]*)$/.exec(prompt.trim());
  return match ? { target: match[1], task: match[2].trim() } : null;
}
