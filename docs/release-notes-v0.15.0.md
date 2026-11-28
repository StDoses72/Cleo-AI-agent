# Cleo v0.15.0

Cleo can now run reusable workflows in a development conversation. For example, a reviewer can send a plan back for changes before an implementation agent starts writing. You choose the steps, who runs them, and what counts as passing review.

## Build and run a workflow

- Open **Workflows** to connect steps on the canvas, or use `/create-workflow` in a development conversation to describe the workflow you want. You can edit the draft before saving it to your library.
- The workflow author drafts as soon as it can infer a useful outcome. Its guidance favors small graphs, clear handoffs, and review criteria that a reviewer can check against evidence.
- Run a saved workflow from the library or with `/workflow <id> <task>`. Follow progress in the conversation and open a step to read its inputs, output, and tool activity.
- Connect steps in sequence, review a result in a bounded loop, or split a list into parallel tasks. Each step can inherit the conversation’s model or use one you select.

## Reviews, retries, and approvals

- Reviewers submit a pass or revise decision with feedback through MCP. Steps that split work submit an ordered list through MCP. Ordinary steps can return their work in their own words.
- If one item fails, retry picks up unfinished work and keeps completed items. If a step could have changed files, you decide whether to retry it.
- Approval requests from steps and their delegated workers appear in the conversation that started the run. When a workflow and another task edit the same workspace at the same time, Cleo disables per-turn undo.

## Reading conversation history

Long conversations keep your reading position when history arrives after you have scrolled away. Small reverse movements from a trackpad and large, folded tool outputs are handled when paging across a long turn.

## Installers

- [Windows x64 installer](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.15.0/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon installer](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.15.0/Cleo-macos-arm64.pkg)
- [macOS Intel installer](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.15.0/Cleo-macos-x64.pkg)
- [Linux x64 Debian package](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.15.0/Cleo-linux-x64.deb)
