# Desktop platforms and installation

[中文](PLATFORMS.md) | [Documentation](README.en.md)

Use the [download page](https://stdoses72.github.io/Cleo-AI-agent/) to select a native package. Available assets are listed on each GitHub Release.

| Platform | Package | Default user data |
| --- | --- | --- |
| Windows x64 | `Cleo-windows-x64.zip` | `%LOCALAPPDATA%\Cleo` |
| macOS Apple Silicon | `Cleo-macos-arm64.zip` | `~/Library/Application Support/Cleo` |
| macOS Intel | `Cleo-macos-x64.zip` | `~/Library/Application Support/Cleo` |
| Linux x64 | `Cleo-linux-x64.tar.gz` or `Cleo-linux-x64.deb` | `$XDG_DATA_HOME/Cleo`, default `~/.local/share/Cleo` |

`CLEO_HOME` can override the data location. Program updates preserve user data. Linux requires a desktop environment and Electron system libraries; native Windows ARM64 and Linux ARM64 packages are not provided.

## Download and install

The download page uses the system information available to the browser and allows manual selection. When Mac architecture is unknown, choose Apple Silicon or Intel explicitly.

The page also offers PowerShell and shell download scripts. They detect native architecture, select assets from one release, verify SHA-256, and save the package to Downloads. They do not install or launch it. The shell script detects Rosetta; unsupported architectures stop without selecting an x64 fallback.

- **Windows**: the source-checkout installer `scripts/download.ps1` installs under `%LOCALAPPDATA%\Programs\Cleo`. The app provides official updates through its version-switching flow.
- **macOS**: place `Cleo.app` in a writable `~/Applications` or `/Applications` directory before updating. Packages use ad-hoc signing and are not Apple-notarized distribution builds.
- **Debian/Ubuntu**: run `sudo apt install ./Cleo-linux-x64.deb`. Install subsequent versions through the package manager. The package configures the Electron sandbox helper and includes a desktop launcher.
- **Linux portable**: extract the archive into a writable directory and run `Cleo/Cleo`. The system must support Electron's user-namespace sandbox.

Portable updates verify platform, architecture, length, and SHA-256 before switching programs. Resolve unsaved evolution changes first. If startup fails, recovery returns to the earlier program while preserving current user data. The Debian package does not self-update system directories.

## Run and build from source

For macOS/Linux desktop development, install Python 3.12+, Node.js 24+, and Git:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
mkdir -p config
cp cleo/config/templates/cleo.example.json config/cleo.json
cp cleo/config/templates/harnesses.example.json config/harnesses.json
npm ci --prefix ui
npm --prefix ui start
```

Configure a model before starting. macOS supports native menus, Command shortcuts, and left-side window controls. Applications launched from Finder include bundled runtimes and common CLI locations in the backend PATH.

Build on the target OS and architecture. Install `uv`, then run:

```sh
npm --prefix ui run package:portable
```

Windows uses `scripts/build-release.ps1`; macOS/Linux use `scripts/build-release.py`. Packages include Python, Node, agent SDKs, and browser tools. macOS builds use `ditto`, `sips`, `iconutil`, and `codesign`; Linux needs `unzip`, `tar`, and `dpkg-deb`.

## Release assets

| Platform | Manifest | Checksum |
| --- | --- | --- |
| Windows x64 | `release.json` | `Cleo-windows-x64.sha256` |
| macOS ARM64 | `release-macos-arm64.json` | `Cleo-macos-arm64.sha256` |
| macOS x64 | `release-macos-x64.json` | `Cleo-macos-x64.sha256` |
| Linux portable | `release-linux-x64.json` | `Cleo-linux-x64.sha256` |

Upload each package with its matching manifest and checksum. The Debian package has its own `Cleo-linux-x64.deb.sha256` and uses the package manager rather than a portable manifest. See [development and releases (Chinese)](DEVELOPMENT.md) for maintainer details.
