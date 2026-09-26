# Cleo configuration

[中文](CONFIGURATION.md) | [Documentation](README.en.md)

`cleo.json` configures chat agents, directories, and tools. `harnesses.json` configures Productivity providers. Both files are validated on startup and contain private local configuration.

## Configuration locations

| Mode | Configuration directory | Data root |
| --- | --- | --- |
| Source checkout | `config/` | Checkout-relative data and memory directories |
| Windows desktop | `%LOCALAPPDATA%\Cleo\config` | `%LOCALAPPDATA%\Cleo` |
| macOS desktop | `~/Library/Application Support/Cleo/config` | `~/Library/Application Support/Cleo` |
| Linux desktop | `$XDG_DATA_HOME/Cleo/config` | `$XDG_DATA_HOME/Cleo`, default `~/.local/share/Cleo` |
| Docker Compose | `/config` | Mounted directories and named volumes |

Use `CLEO_CONFIG_PATH` and `CLEO_HARNESSES_CONFIG_PATH` to select configuration files. Packaged applications set `CLEO_HOME`; source checkouts resolve relative paths from the repository.

## Model profiles

Start with [the configuration template](../cleo/config/templates/cleo.example.json). `active_profiles` selects named entries from `profiles`:

```json
{
  "active_profiles": {
    "agent": "primary",
    "dream_agent": "economy",
    "directory": "default",
    "shell": "default",
    "tools": "default"
  },
  "profiles": {
    "agents": {},
    "directories": {},
    "shell": {},
    "tools": {}
  }
}
```

This illustrates the registry structure; fill in the referenced profiles before starting. An API model profile looks like:

```json
{
  "provider": "openai",
  "model": "your-model",
  "temperature": 0.7,
  "max_tokens": 100000,
  "api_key": "YOUR_API_KEY",
  "base_url": "https://provider.example/v1"
}
```

`agent` selects foreground Cleo. `dream_agent` selects memory consolidation; when omitted or null, it follows the source Chat session's model. Use values supported by your provider. Keys remain plaintext in the configuration file, although desktop read APIs do not return them in plaintext.

Chat also supports subscription connections authenticated through official CLIs. See [subscription connections and DreamAgent (Chinese)](SUBSCRIPTION_CHAT.md).

## Directories and memory

Directory profiles resolve paths relative to `root_dir`:

| Field | Default | Purpose |
| --- | --- | --- |
| `data_dir` | `data` | Runtime state and tool artifacts |
| `skills_dir` | `skills` | Cleo skills |
| `workspace_dir` | `workspace` | Workspace files |
| `memory_dir` | `memory` | Sessions and project memory |
| `memory_policy_path` | `memory/MEMORY_POLICY.md` | Developer-owned extraction policy |
| `persona_path` | `PERSONA.md` | Existing persona content |
| `session_index_path` | `memory/sessions.sqlite3` | Session registry |
| `session_artifacts_dir` | `data/session_artifacts` | Large tool and browser artifacts |
| `runtime_state_path` | `data/runtime.json` | Navigation state |

`events.jsonl` retains original session events. Manifests, compact views, and indexes support navigation and retrieval. Project `MEMORY.md` stores current preferences with independent Git history; it should not be discarded as a database-rendered cache. See [Markdown memory and migration (Chinese)](MEMORY_MARKDOWN_GIT.md).

`space` separates `non_productivity` and `productivity` data. `project` scopes memory; `cwd` is the real directory used by a development harness. Changing a chat project does not change a harness working directory.

## Shell and browser tools

Shell profiles provide `sandbox_root`, command allowlisting, path checks, approval settings, timeouts, output limits, and audit logging. A typical profile is:

```json
{
  "sandbox_root": ".",
  "audit_log_path": "data/shell_audit.log",
  "require_allowlist": true,
  "enforce_sandbox": true,
  "require_approval": false,
  "timeout_seconds": 30,
  "max_output_chars": 12000,
  "allowed_commands": ["python", "git"],
  "include_platform_defaults": true,
  "denied_patterns": []
}
```

These are application controls, not an OS sandbox. Approval requires an interactive approval channel.

The tools profile includes `tavily_api_key` for search and `codex_model` for the internal Codex tool/MCP default. Browser configuration selects its command, enabled state, domain restrictions, timeouts, and output limits. `allow_private_network` defaults to false. Each thread has its own browser session; artifacts are stored under `session_artifacts_dir/browser/`.

## Development harnesses

Start with [the harness template](../cleo/config/templates/harnesses.example.json):

```json
{
  "default_provider": "codex",
  "providers": {
    "codex": {
      "type": "codex_sdk",
      "enabled": true,
      "model": "gpt-5.5",
      "options": {
        "approval_mode": "deny_all",
        "sandbox": "workspace-write"
      }
    }
  }
}
```

| Type | Main settings |
| --- | --- |
| `codex_sdk` | Model, approval mode, sandbox |
| `claude_sdk` | Model and permission mode |
| `acp` | Command, arguments, environment, auto-approval |

The default provider must exist and be enabled. Codex supports `deny_all`, `auto_review`, and `user` approval modes. Desktop maps `auto_review` to interactive `user` approvals; explicitly configured `deny_all` remains unchanged. CLI follows its configured mode. Capabilities and permissions vary by harness.

Keep credentials, event logs, and artifacts private. Model requests go to the selected provider. When moving data, preserve the complete scoped directory structure and stop Cleo before copying files that may be actively written.
