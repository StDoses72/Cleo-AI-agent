# AI4Casting Deepagent Architecture

## Decisions

- Keep minimal deepagent runtime pattern.
- Use a filesystem-backed deepagent so the agent can inspect and produce project artifacts.
- Keep skills as the main extension point for casting-specific workflows.
- Store lightweight CLI runtime state in JSON so interrupted interactive
  sessions can be detected on the next launch.
- Store thread message snapshots separately from LangGraph checkpoints. The
  current checkpointer is still in-memory; durable graph checkpointing is a
  future option.

## Layers

1. Entry Layer (`main.py`)
   - Accepts a one-shot user message or starts an interactive chat loop.
   - Creates `core.agent.Agent`.
   - Sends the message through a stable thread id.
   - Snapshots thread messages on `/quit`, `/exit`, `/reset`, `EOF`, and
     `KeyboardInterrupt`.

2. Runtime Layer (`core/agent.py`)
   - Configures `ChatOpenAI`.
   - Creates the deepagent with `FilesystemBackend`.
   - Loads skills from `/skills`.
   - Keeps an in-memory checkpointer for local sessions.

3. CLI Runtime State Layer (`core/runtime/`)
   - Loads and updates `data/runtime.json`.
   - Tracks `current_project`, `current_thread_id`, `projects_list`, and
     `recent_threads`.
   - Syncs project names from `memory/projects/`.

4. Thread Snapshot Layer (`core/memory/`)
   - Serializes LangChain messages with `messages_to_dict`.
   - Writes raw thread snapshots to `memory/thread_objects/{thread_id}.json`.
   - Appends snapshot metadata to `memory/threads.jsonl`.
   - Does not yet restore messages into a live deepagent invocation.

5. Configuration Layer (`config/settings.py`)
   - Loads `.env`.
   - Exposes model, key, data, memory, workspace, and skills paths.
   - Exposes restricted shell-tool sandbox and allowlist settings.

6. Packaging and Dependency Layer (`pyproject.toml`)
   - Defines project metadata and Python runtime dependencies.
   - Uses `setuptools` as the build backend.
   - Exposes the `ai4casting` console command as `main:main`.
   - Keeps `requirements.txt` as a compatibility wrapper that delegates to
     editable installation.

7. Skills Layer (`skills/`)
   - Holds domain procedures and future tool instructions.
   - Contains workflow-specific `SKILL.md` instructions, deterministic scripts,
     and output profiles.
   - Current production-shaped workflow: `die-casting-gate-design`.
   - Additional local skills include `cad-geometry-extractor`,
     `pptx-ai-template-flow`, and `presentations`.

8. Workspace Layer (`workspace/`)
   - Temporary user/workflow files visible to the agent.
   - Current gate design outputs are written under
     `workspace/die-casting-gate-design/`.
   - CAD/STL analyzer jobs may write temporary artifacts under
     `workspace/stp_analyzer_jobs/`.

9. Data Layer (`data/`)
   - Stores CLI runtime state in `data/runtime.json`.
   - Stores runtime audit logs such as `data/shell_audit.log`.
   - Reserved for future casting references and generated non-session datasets.
   - No CMU course data is carried over.

## Current Project Structure

```text
AI4Casting/
  pyproject.toml                  # Project metadata and Python dependencies
  requirements.txt                # Compatibility wrapper for editable install
  main.py                         # CLI entry point
  config/                         # .env-backed runtime settings
  core/
    agent.py                      # Deepagent construction and system prompt
    memory/
      thread_memory.py            # Message snapshot serialization
    runtime/
      model.py                    # Runtime JSON model/update helper
  data/
    runtime.json                  # Current CLI runtime state
    shell_audit.log               # Restricted shell tool audit log
  docs/                           # Architecture and project notes
  memory/
    AGENT.md                      # Long-lived agent memory file
    projects/                     # Project-scoped memory folders
    thread_objects/               # Serialized thread message snapshots
    threads.jsonl                 # Snapshot metadata registry
  skills/
    cad-geometry-extractor/       # STL geometry extraction workflow
    die-casting-gate-design/
      SKILL.md                    # Die-casting gate design workflow
      scripts/
        casting_design_process.py # Deterministic workflow/calculation script
        markdown_output.py        # Markdown export helper
      profiles/
        final_design_template.json # Final output JSON profile template
    pptx-ai-template-flow/        # PPTX template analysis/fill flow
    presentations/                # Presentation authoring support skill
  tools/
    shell_tools.py                # Restricted run_shell_command tool
  workspace/
    die-casting-gate-design/
      state.json                  # Temporary incomplete workflow state
      final_design.json           # Temporary completed final profile
```

## Runtime and Thread Lifecycle

`main.py` generates local thread ids in the form:

```text
local-{12_hex_chars}
```

At the start of an interactive loop, `runtime.current_thread_id` is set to the
active thread. During normal conversation, LangGraph state lives in the
process-local `InMemorySaver`.

When a thread needs to be snapshotted, `main._save_thread_snapshot()` reads:

```python
agent.deepagent.get_state(config).values.get("messages", [])
```

and writes those messages through `core.memory.thread_memory.save_messages_to_file`.

Current CLI behavior:

- `/quit` and `/exit`: save the thread, append it to `recent_threads`, then
  clear `current_project` and `current_thread_id`.
- `/reset`: save the old thread, append it to `recent_threads`, clear the
  project, and start a new `current_thread_id`.
- `EOF` and `KeyboardInterrupt`: save the thread but keep
  `current_thread_id`, allowing the next process to detect an unfinished
  session.

Because the graph checkpointer is in-memory, saved message snapshots are not
full LangGraph checkpoints. They are conversation-history snapshots intended
to bootstrap the first resume implementation.

## Resume Design Notes

The intended short-term resume flow is:

1. Detect `runtime.current_thread_id` on startup.
2. Ask the user whether to continue that thread.
3. Load `memory/thread_objects/{thread_id}.json`.
4. Rehydrate LangChain messages with `messages_from_dict`.
5. On the first resumed user turn, pass the restored messages plus the new
   user message as the deepagent input for that same `thread_id`.
6. Let the deepagent invocation recreate active LangGraph state in the
   in-memory checkpointer.

Do not use `deepagent.update_state({"messages": restored_messages})` as the
primary resume mechanism for the current deepagents version. The `messages`
channel uses LangGraph `DeltaChannel`, and direct `update_state` did not
reconstruct messages during local probing.

Longer term, the cleaner design is to replace `InMemorySaver` with a durable
LangGraph checkpointer when a stable local checkpointer dependency is selected.
That would persist full graph state instead of rebuilding from message
history.

## Gate Design Workflow

The `die-casting-gate-design` skill is the current migrated v3 business flow.
It keeps v3's deterministic die-casting internal gate design behavior while
using the Deep Agents skill/script pattern instead of the v3 self-built
`LeadAgent` runtime.

The preferred script command is `advance`:

```text
python skills/die-casting-gate-design/scripts/casting_design_process.py advance ...
```

`advance` accepts the current draft fields, automatically performs every
available deterministic step, returns `next_question` when user input is still
missing, and returns `final_design` when the workflow is complete.

The final profile is generated from:

```text
skills/die-casting-gate-design/profiles/final_design_template.json
```

and temporarily written to:

```text
workspace/die-casting-gate-design/final_design.json
```

`field_sources.source_type` is intentionally small:

- `STL_data`
- `user_input`
- `script_calculation`
- `manual_fallback`

Warnings are used for source reliability risks, especially geometry-critical
fields supplied by the user or manual fallback calculations.

## Removed From Source Prototype

- `api/course_api.py`
- CMU schedule scraping
- FCE ingestion
- Course SQLite reader/import skills
- Course/FCE CSV, SQLite, catalog, and schedule datasets

## Near-Term Extension Points

- Implement thread resume from `memory/thread_objects/{thread_id}.json`.
- Add optional autosave after every assistant turn once resume behavior is
  working.
- Add persistent session storage for `workspace/die-casting-gate-design/` outputs.
- Add Markdown export from `final_design.json`.
- Add `skills/defect_analysis` for porosity, shrinkage, cold shut, misrun,
  inclusion, hot tearing, and surface defect workflows.
- Add `skills/dfm_review` for manufacturability review checklists.
- Add `skills/material_process` for alloy, mold, gating, overflow, and heat-treatment
  reasoning.
- Add structured adapters only after the first real casting data source is known.
