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

New releases include graphical installers: `Cleo-windows-x64-setup.exe`, `Cleo-macos-arm64.pkg`, `Cleo-macos-x64.pkg`, and the Linux `.deb`. Double-click the matching installer. The page prefers installers with published checksums and explicitly labels portable downloads on older releases.

These are lightweight online installers. They download the verified program archive, then Python, Node and the tested dependency versions from official sources. Windows prepares the runtime before copying into the selected program directory. macOS installs into `/Applications` with administrator authorization and rejects the wrong chip architecture. Debian/Ubuntu software installers resolve system dependencies and prepare the runtime during package configuration. Preparation usually takes several minutes. The Windows wizard shows the current step, download sizes, and Python package progress, and can be cancelled at any time; cancelling removes downloaded and partly prepared files. A failure names the step that failed, with details in `%TEMP%\Cleo-install.log`. The macOS installer log and Linux `apt` output print one line per step. No first-launch dependency dialog is shown. Optional Docker/desktop setup and runtime repair remain available in settings. Uninstalling the application preserves user data and dependency caches.

Python and Node archives have pinned SHA-256 hashes; Python packages require hashes and binary wheels, and npm uses lockfile integrity. Failed preparations never become ready; verified downloads and identical runtime plans can be reused. Runtime storage is `%LOCALAPPDATA%\Cleo\runtimes\online` on Windows, `/Library/Application Support/Cleo/runtimes/online` for macOS PKGs, and `/var/lib/cleo/runtimes/online` for DEBs. In-app updates prepare environments under user data and can reuse matching system installations. The signed app bundle is never modified to install dependencies.

macOS installers and apps are not notarized. For a trusted official download that macOS blocks, use **System Settings → Privacy & Security → Open Anyway** after attempting to open it. See [Apple's instructions](https://support.apple.com/102445). Installers do not remove quarantine attributes or disable Gatekeeper.

- **Windows**: the source-checkout installer `scripts/download.ps1` installs under `%LOCALAPPDATA%\Programs\Cleo`. The app provides official updates through its version-switching flow.
- **macOS**: use the ARM64 PKG on Apple Silicon and x64 PKG on Intel. Use a new PKG to update a system-owned installation; portable users can place `Cleo.app` in a writable `~/Applications` or `/Applications` directory for in-app updates. Apps use ad-hoc signing.
- **Debian/Ubuntu**: double-click the DEB to use the system software installer, or run `sudo apt install ./Cleo-linux-x64.deb`. Install subsequent versions through the package manager. The package configures the Electron sandbox helper and includes a desktop launcher.
- **Linux portable**: complete local development builds can be extracted into a writable directory and run as `Cleo/Cleo`. Published slim program archives require a prepared runtime; use the DEB for first installation. The system must support Electron's user-namespace sandbox.

Portable updates verify platform, architecture, length, and SHA-256 before switching programs. Resolve unsaved evolution changes first. If startup fails, recovery returns to the earlier program while preserving current user data. The Debian package does not self-update system directories.

Online packages use manifest schema 2 and evolution protocol 3. New clients prepare dependencies before offering a version switch. Older clients reject the new format and must first migrate through the graphical installer. New clients continue accepting full protocol-2 packages.

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

Release CI builds with `-Online` on Windows and `--online` on macOS/Linux, then runs `python scripts/build-installers.py` on Windows/macOS. Windows needs Inno Setup 6 (`ISCC.exe` on PATH or in its default location); macOS uses `pkgbuild`. Linux produces a lightweight DEB directly. The build validates dependencies, then removes Python, Node, SDKs and node_modules from release archives, retaining the application wheel and checksummed installation plan. Each release resolves the newest stable compatible binary dependencies; installation uses that tested snapshot. Complete local development builds remain available without the online flag.

## Release assets

| Platform | Manifest | Checksum |
| --- | --- | --- |
| Windows x64 | `release.json` | `Cleo-windows-x64.sha256` |
| macOS ARM64 | `release-macos-arm64.json` | `Cleo-macos-arm64.sha256` |
| macOS x64 | `release-macos-x64.json` | `Cleo-macos-x64.sha256` |
| Linux portable | `release-linux-x64.json` | `Cleo-linux-x64.sha256` |

Upload each package with its matching manifest and checksum. The Debian package has its own `Cleo-linux-x64.deb.sha256` and uses the package manager rather than a portable manifest. See [development and releases (Chinese)](DEVELOPMENT.md) for maintainer details.

Each EXE and PKG also requires a checksum named after the complete filename plus `.sha256`. Publication automatically uploads the lightweight installers, slim program archives and metadata together. Dependency distributions are fetched upstream during installation, not uploaded to the Cleo release.

## Release validation

`Desktop platforms` builds all four native targets, runs each EXE/PKG/DEB installer, and checks that the installed application renders and connects to its bundled backend with a fresh temporary profile. An error page alone cannot pass. Publication verifies the tag, versions, dependency snapshot, assets and SHA-256 checksums.

Feature tests remain available for development but are not release gates. Adding or removing product features does not require preserving old buttons or workflows. Automatic repair runs `npm --prefix ui run check:release` for compilation only and must preserve the selected version's behavior.
