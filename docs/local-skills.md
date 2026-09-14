# Local skills in development sessions

Cleo discovers skills for the selected native Claude or Codex harness when loading a
development thread or selecting a new task's harness. Type `/gri` to filter by
skill name, use arrows and Enter/Tab or click to insert the command, then add
arguments and send. Selection never submits a task; IME composition is guarded.
Entries show their harness and
user/project scope, with the exact file path available on hover. `/eli5` and
`/eli5 explain recursion` load the actual local `SKILL.md`, including its resource
directory, into the provider request. The existing conversation record contains
the invocation, source path and loaded instructions for inspection.

Supported directories:

- Claude: `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`) and project
  `.claude/skills` directories.
- Codex: `$CODEX_HOME/skills` (default `~/.codex/skills`), `~/.agents/skills`,
  and project `.codex/skills` and `.agents/skills` directories.
- Project discovery visits the working directory and its parents up to the Git
  root. Each skill has its own directory containing `SKILL.md`; `.system` skills
  are also supported. Symlinked skill directories are resolved and deduplicated.

Built-in commands keep their names. Duplicate or reserved skill names receive
stable `/skill:name:id` commands, so each source remains selectable. Files with
`user-invocable: false` are excluded. Missing, empty or unreadable skills cannot
be invoked; discovery never creates or repairs files.

This first stage supports native Claude/Codex development sessions only. Chat,
evolution sessions, other ACP harnesses, plugin registry discovery, and
cross-harness reuse are outside its scope. Reopen a thread to refresh its catalog
after installing skills. This is instruction loading, not emulation of all
vendor-specific execution options; existing harness permissions still apply.

No catalog is persisted and no user data schema, profile, or migration changes
are introduced. Automated regressions use temporary files. The desktop's frozen
manual acceptance cases still require real harness verification.

Claude's native connection enables `setting_sources=["user", "project"]` for
automatic discovery. Codex retains its native skill discovery and trigger rules.
The explicit menu's user-invocable filter does not disable automatic-only skills
in the native runtime. Unsupported harnesses are not given an invented catalog
or a claim that a skill ran. See [validation and compatibility](iteration-interactions.md).
