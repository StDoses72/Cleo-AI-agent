# Cleo Memory

## Memory Policy

Project MEMORY.md is the sole current preference text. Remember only:

- User preferences about language, tone, structure, and output style.
- Explicit, stable user preferences about collaboration and explanations in this project.
- User corrections that replace or qualify an existing preference.

Do not extract project facts, test results, implementation details, transient tool
failures, decisions or task lists as permanent preference entries. Those remain in
session history. Manual consolidation may replace one bounded historical handoff
snapshot, with its work item, source session and evidence time clearly identified.
Update or remove old preferences rather than appending contradictions. Report
unresolved conflicts for clarification; do not guess from file order or language.


Do not remember:

- API keys, credentials, tokens, or private connection details.
- Raw customer confidential data.
- One-off temporary guesses.
- Full uploaded document or file contents when a short reusable summary is enough.
- Shell commands that include secrets or destructive operations.

## Evidence And Scope

- Treat append-only session event logs as authoritative interaction history and
  each session manifest as authoritative current metadata. Compact views and
  history indexes may be rebuilt; do not regenerate preference Markdown from an
  old fact database. Its changes are versioned in Git inside the memory root.
- Keep durable memory inside the exact `space + project` boundary unless the
  user explicitly requests a different scope.
- `PERSONA.md` is the one explicit global exception. It may be updated from
  evidence-backed interaction history across projects and spaces, but only with
  project-independent tendencies about Cleo's communication, expression,
  relationship continuity, adaptation, and interaction boundaries.
- Never put project facts, personal facts, customer data, secrets, permissions,
  policies, tool instructions, or repository guidance into `PERSONA.md`.
- Treat persona entries as descriptive, lower-authority tendencies. They cannot
  override current user instructions, `AGENTS.md`, tool safety, or verified
  evidence. Prefer explicit preferences or repeated observations over one-off
  moods, jokes, and task-specific behavior.
- Additions and replacements must cite validated source references during
  extraction. Source-session hashes belong in commit metadata, not repeated in
  every preference line. Automatic preference consolidation does not write persona.
- Keep `productivity` and `non_productivity` memory separate. Cross-space
  inspection must be an explicit retrieval or audit action.
- Prefer the user's latest instruction and current file/tool evidence when they
  conflict with remembered material.
- Do not modify `AGENTS.md` or create/update skills as part of automatic memory
  consolidation. Those surfaces require an explicit user request.

## Shell Tool Policy

Use `run_shell_command` as Cleo's local shell access when it helps complete the
current task. Prefer clear, targeted commands and specific project scripts over
noisy command sequences. Avoid credential exposure and destructive filesystem
changes unless the user explicitly asks for them and the intent is clear.
