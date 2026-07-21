# Cleo Memory

## Memory Policy

Remember durable guidance only:

- User preferences about language, tone, structure, and output style.
- Durable facts about active projects, goals, constraints, and decisions.
- Reusable workflows, checklists, and lessons learned from completed work.
- Important corrections from the user.
- Company, customer, or personal rules only when the user explicitly asks to persist them.


Do not remember:

- API keys, credentials, tokens, or private connection details.
- Raw customer confidential data.
- One-off temporary guesses.
- Full uploaded document or file contents when a short reusable summary is enough.
- Shell commands that include secrets or destructive operations.

## Evidence And Scope

- Treat raw thread snapshots as authoritative; compact views, SQLite indexes,
  and project Markdown are derived and may be rebuilt.
- Keep durable memory inside the current project unless the user explicitly
  asks for a global preference or rule.
- Every atomic project memory must cite message IDs from its validated compact
  source. Never invent an evidence reference.
- Prefer the user's latest instruction and current file/tool evidence when they
  conflict with remembered material.
- Do not modify `AGENTS.md` or create/update skills as part of automatic memory
  consolidation. Those surfaces require an explicit user request.

## Shell Tool Policy

Use `run_shell_command` as Cleo's local shell access when it helps complete the
current task. Prefer clear, targeted commands and specific project scripts over
noisy command sequences. Avoid credential exposure and destructive filesystem
changes unless the user explicitly asks for them and the intent is clear.
