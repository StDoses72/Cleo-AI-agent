# Cleo v0.14.2

Cleo v0.14.2 opens about five seconds sooner and gets a task's first message after a restart to its harness much sooner. It also adds Codex Ultrafast on the models that offer it, brings Gemini development tasks through Google Antigravity, and keeps a task's permissions in one place.

## Faster start and send

- The window and the first screen no longer wait for the harness SDKs to load. On the test machine, the first screen went from 6–8 s to about 1.4 s.
- When you start writing in a development task, Cleo resumes its harness in the background. On the test machine, a message sent after a restart was answered in 2–5 s instead of 12–15 s.
- Claude tasks no longer restart the Claude CLI when they start with a reasoning effort.
- The packaged app opens its window while it checks its runtime, and starts the backend as soon as that check ends.
- A brand-new task still waits for its harness to start on the first message.

## Codex Ultrafast

- On a model whose Codex catalog lists Ultrafast (currently `gpt-6.2-sol`), the menu under reasoning effort lists Standard, Fast and Ultrafast, each with the catalog's description. Other models keep the Fast switch.
- A task keeps the speed you chose. When the current model does not offer it, the turn runs at Standard, the menu says so, and the effort chip reads "· Standard". Switching back to a model that offers it restores your choice.
- Ultrafast appears with openai-codex 0.170 or later, which this release bundles.

## Gemini through Google Antigravity

- **`antigravity`** runs the Antigravity CLI's own ACP server (`agy acp`) and uses a Google AI Pro / Ultra subscription. Install the Antigravity CLI and sign in once with `agy` or `agy acp --login`.
- **`antigravity-sdk`** runs the bundled Antigravity SDK on a Gemini API key (`GEMINI_API_KEY`) or Google Cloud (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and `gcloud auth application-default login`). The SDK has no Google-account sign-in, so it cannot use a subscription.
- Tasks on the SDK stream thinking and text, show tool calls, ask for approval in Cleo, can be stopped and resume after a restart. File tools outside the task's folder never run.
- These two harnesses have not yet been verified with real accounts.

## Permissions

- A task's permissions are chosen in one place, the preset in the composer. The details panel no longer repeats file access and approval policy for harnesses with presets (Codex, Claude). ACP harnesses keep their approval choice in the panel.
- A new task starts with the preset last used on its harness.
- Codex and Claude combinations that are not a preset can no longer be chosen in the interface.

## Updating

- Conversations, memory and settings are not touched. Timeline indexes keep their format.
- `harnesses.json` is unchanged unless you start a task on `antigravity`. That entry uses the existing ACP format, which older versions can read.
- Installers are about 40 MB larger because of the bundled Antigravity SDK.

## Documentation

- [ADR 0014](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.2/docs/adr/0014-codex-speed-from-the-model-catalog.md) records how Codex speeds follow the model catalog.
- [ADR 0015](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.2/docs/adr/0015-start-and-send-without-waiting-on-harness-imports.md) records the start and send changes, with the measurements and what is not done.
- [ADR 0016](https://github.com/StDoses72/Cleo-AI-agent/blob/v0.14.2/docs/adr/0016-antigravity-sdk-and-cli-harnesses.md) records the two Gemini paths and why the SDK cannot use a subscription.

## Installers

- [Windows x64 EXE](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.2/Cleo-windows-x64-setup.exe)
- [macOS Apple Silicon PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.2/Cleo-macos-arm64.pkg)
- [macOS Intel PKG](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.2/Cleo-macos-x64.pkg)
- [Linux x64 DEB](https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.14.2/Cleo-linux-x64.deb)
