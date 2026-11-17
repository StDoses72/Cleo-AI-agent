# Getting started with Cleo

[中文](GETTING_STARTED.md) | [Documentation](README.en.md)

Cleo brings chat, development agents, and project memory into one workspace.

## Install the desktop app

Choose your platform on the [Cleo download page](https://stdoses72.github.io/Cleo-AI-agent/), or download a package from [GitHub Releases](https://github.com/StDoses72/Cleo-AI-agent/releases/latest). See [platform installation](PLATFORMS.en.md) for package formats and data locations.

Windows users with a source checkout can also use the verified installer:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\download.ps1 -Launch
```

It verifies SHA-256 and installs the program under `%LOCALAPPDATA%\Programs\Cleo`. User configuration, conversations, and memory live separately under `%LOCALAPPDATA%\Cleo`.

## Configure a model

Open Settings → Models and create a connection with your provider, model name, API key, and optional base URL. Assign profiles to Cleo and DreamAgent; they can use the same model or different models. See [configuration](CONFIGURATION.en.md).

Start a Chat conversation, for example:

```text
Help me turn my product idea into requirements and acceptance criteria.
```

A new chat is standalone by default (the backend records it under `general`). To keep topics and memory apart, pick a project from the composer's project selector or add one there; a chat project does not need a code directory. The sidebar lists threads under their project, with standalone ones below.

For development, a new task is standalone by default and runs in Cleo's own directory. To work inside a code directory, pick the project from the composer's project selector or add a folder there. The model control reads "harness · model": its menu lists the current harness's models, and its heading leads back to the harness list. A harness that fails its check stays listed, marked as not connected. Reasoning effort is a control of its own beside it, with fast mode (shown only when the harness and model support it) and reset in its menu. Session permissions can be chosen before the task is created. Subtask routing is switched in Settings only, and a new task follows that setting. Authentication belongs to the selected harness.

The ring beside the send button shows context usage; click it for the figures and, on Codex and Claude, the account's usage windows. While a task runs, its thinking is written into the timeline as prose and each run of tool calls is one line; once the reply follows, that stretch folds behind one summary line.

## Run from source

Use Python 3.12 or newer. In PowerShell:

```powershell
git clone https://github.com/StDoses72/Cleo-AI-agent.git
Set-Location Cleo-AI-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
New-Item -ItemType Directory -Force config | Out-Null
Copy-Item cleo\config\templates\cleo.example.json config\cleo.json
Copy-Item cleo\config\templates\harnesses.example.json config\harnesses.json
```

In Bash:

```bash
git clone https://github.com/StDoses72/Cleo-AI-agent.git
cd Cleo-AI-agent
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
mkdir -p config
cp cleo/config/templates/cleo.example.json config/cleo.json
cp cleo/config/templates/harnesses.example.json config/harnesses.json
```

Fill in your model and credentials in `config/cleo.json`. Browser tools also need Node.js, a local Chrome or Edge installation, and `agent-browser`:

```bash
npm install -g agent-browser@0.33.1
```

Then install the desktop dependencies with `npm ci --prefix ui` and run `npm --prefix ui start`. The desktop app starts the Python backend (`python -m cleo.desktop.server`) from the source tree. Cleo no longer ships a terminal CLI; configuration templates can be copied from `cleo/config/templates/`. See [platform requirements](PLATFORMS.en.md).


Next: explore [local skills](local-skills.en.md) or [program versions and recovery](program-versions.en.md).
