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

## Shell Tool Policy

Use `run_shell_command` only for project-local scripts or diagnostics that are
required by the current task. Prefer specific scripts referenced by a skill.
Do not use shell execution for broad filesystem exploration, destructive
operations, credential handling, or commands outside the configured sandbox.
