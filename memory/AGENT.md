# AI4Casting Memory

## Memory Policy

Remember durable project guidance only:

- User preferences about language, report structure, and output style.
- Reusable casting process knowledge.
- Repeated defect diagnosis patterns.
- Lessons learned from completed casting cases.
- Company or customer rules only when the user explicitly asks to persist them.


Do not remember:

- API keys, credentials, tokens, or private connection details.
- Raw customer confidential data.
- One-off temporary guesses.
- Full uploaded document contents when a short reusable summary is enough.
- Shell commands that include secrets or destructive operations.

## Shell Tool Policy

Use `run_shell_command` only for project-local scripts or diagnostics that are
required by the current task. Prefer specific scripts referenced by a skill.
Do not use shell execution for broad filesystem exploration, destructive
operations, credential handling, or commands outside the configured sandbox.

