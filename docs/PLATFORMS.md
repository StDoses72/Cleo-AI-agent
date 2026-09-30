# 桌面平台支持

[English](PLATFORMS.en.md)

Cleo 提供以下原生安装包，可从 [Cleo 统一下载页](https://stdoses72.github.io/Cleo-AI-agent/)
选择下载。各平台必须在对应系统和 CPU 架构上构建。

| 目标 | 程序 | 发布文件 | 用户数据 |
| --- | --- | --- | --- |
| Windows x64 | `Cleo/Cleo.exe` | `Cleo-windows-x64.zip` | `%LOCALAPPDATA%\Cleo` |
| macOS Apple Silicon | `Cleo.app` | `Cleo-macos-arm64.zip` | `~/Library/Application Support/Cleo` |
| macOS Intel | `Cleo.app` | `Cleo-macos-x64.zip` | `~/Library/Application Support/Cleo` |
| Linux x64 | `Cleo/Cleo` | `Cleo-linux-x64.tar.gz`、`Cleo-linux-x64.deb` | `$XDG_DATA_HOME/Cleo`，默认 `~/.local/share/Cleo` |

新发布同时提供双击安装入口：Windows 的 `Cleo-windows-x64-setup.exe`、macOS 的
`Cleo-macos-arm64.pkg` / `Cleo-macos-x64.pkg`，以及 Debian / Ubuntu 的 `.deb`。
下载页优先提供已发布且带校验文件的安装器；旧版本缺少安装器时会明确显示「便携包」。

Linux ARM64、Windows ARM64 原生包不在本次范围内。Linux GUI 需要桌面环境和 Electron
运行库；原生 CI 以 Ubuntu 24.04 验证。`CLEO_HOME` 可以覆盖数据位置，更新只替换程序目录。

## macOS 与 Linux 源码运行

准备 Python 3.12+、Node.js 24+、Git，运行：

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

macOS 使用原生应用／编辑／窗口菜单、Command 快捷键和左侧窗口按钮。Finder 启动时，
后端 PATH 会包含内置运行环境、Homebrew 和常见用户 CLI 目录；不会执行用户 shell 配置
来探测 PATH。自定义位置可通过现有 provider 命令配置或环境 PATH 指定。

## 原生构建

安装 `uv` 后，在相应系统与架构上运行：

```sh
npm --prefix ui run package:portable
```

Windows 委派现有 `build-release.ps1`；macOS/Linux 使用 `build-release.py`。构建器使用
全新的 UI 依赖目录，校验官方 Electron 下载，装入独立 Python 3.12、Node、Codex/Claude SDK
和浏览器工具。macOS 使用系统 `ditto`、`sips`、`iconutil`、`codesign`；Linux 需要 `unzip`、
`tar`、`dpkg-deb`。若 `release/Cleo` 或 `release/Cleo.app` 已存在，先将上次产物移走再构建。

正式发布使用联网模式：Windows 构建传入 `-Online`，macOS/Linux 传入 `--online`。
Windows/macOS 完成程序包构建后，运行 `python scripts/build-installers.py` 生成轻量图形安装器。
Windows 需要 Inno Setup 6（`ISCC.exe` 位于 PATH 或默认安装目录）；macOS 使用系统 `pkgbuild`。
Linux 构建直接生成轻量 `.deb`。CI 自动执行完整流程，不需要手动为各平台装配依赖。
构建时先验证依赖，再将 Python、Node、SDK 和 node_modules 从发布程序包中移除，留下
应用 wheel、带哈希的 Python 锁文件、npm 锁文件及运行环境下载清单。
每次构建选择最新稳定且兼容的平台组合；安装时使用该份已验证清单。
依赖必须提供二进制 wheel，避免 Intel Mac 将 `cryptography` 源码编译后引用 Homebrew OpenSSL。
默认的本地开发构建仍可产生完整便携包，供本机进化验证使用。

macOS 当前构建产物采用 ad-hoc 签名，用于本地运行和 CI 验证，**不等同于 Developer ID 签名
及 Apple 公证的正式分发包**。macOS 附件以开发签名构建提供；要生成经过公证的
分发包，需要发行者配置 Apple 凭据、签名和公证流程，
并对最终签名后的 ZIP 重新生成校验清单；脚本不会移除 Gatekeeper 隔离属性或关闭验证。
参见 [Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)。

## 安装与更新

统一下载页优先使用浏览器提供的系统、架构和位数信息，无法确认时保留手动选择。
Safari 的 `Intel Mac` 字样不能证明电脑使用 Intel 芯片；浏览器未提供架构时不会默认下载 Intel 包。
相关 API 的可用性与权限限制见 [MDN](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues)。

下载页同时提供 Windows PowerShell 和 macOS/Linux shell 下载命令：直接读取系统架构、
固定到同一 Release 版本、验证对应的 SHA-256，然后保存安装包；不解压、安装或启动应用。
macOS 脚本会识别 Rosetta，选择原生 Apple Silicon 包。Windows ARM64、Linux ARM64 和 32 位
系统会停止并提示，不退回到 x64。已有不同内容的同名文件不会被覆盖，失败下载会清理。
源码中的入口为 `download/site/download.ps1`（`-OutputDirectory` 可指定目录）及
`download/site/download.sh`（第一个参数可指定目录），默认保存到用户主目录下的 `Downloads`。
这些高级入口只下载程序包；新版首次安装请使用 EXE、PKG 或 DEB，以便先准备运行环境。

联网安装器先下载并验证主程序，再从官方源下载 Python、Node 和锁定的依赖。Python/Node
归档使用 SHA-256，Python 依赖使用 `--require-hashes`，npm 使用锁文件的完整性校验。
下载、安装或运行检查失败时不会标记环境就绪，可以重试；校验通过的下载和相同清单的环境可复用。
macOS 的安装日志和 Linux 的 `apt` 输出会逐行显示当前准备步骤。
Windows 用户可以在向导中选择程序目录；依赖环境默认保存在 `%LOCALAPPDATA%\Cleo\runtimes\online`。
macOS PKG 使用 `/Library/Application Support/Cleo/runtimes/online`，Linux DEB 使用
`/var/lib/cleo/runtimes/online`。应用内更新在用户数据目录下准备环境，兼容已有系统缓存；
依赖不写入签名后的 `.app`。卸载程序保留用户数据和依赖缓存。

- macOS：M 系列选择 ARM64 PKG，Intel 选择 x64 PKG，双击后按系统安装向导安装到
  `/Applications`。安装器会拒绝错误芯片的包，并在完成前下载、验证运行环境。PKG 安装需
  管理员授权；系统所有的安装目录可通过新版 PKG 更新。便携包用户将 `Cleo.app` 放入可写的
  `~/Applications` 或 `/Applications`。只读磁盘映像、
  App Translocation 或无写权限的位置会拒绝更新，原程序保持打开；需要先移动应用。
- Linux：Ubuntu/Debian 双击 `.deb`，在系统软件安装程序中安装；没有图形包管理器时使用
  `sudo apt install ./Cleo-linux-x64.deb`。系统依赖由包管理器处理，桌面入口随包安装，
  配置阶段联网准备并验证运行环境，失败会返回安装错误；网络恢复后可重试配置。
  该包正确设置 Electron sandbox helper 的所有权与权限，通过包管理器安装新版进行更新。
  `.deb` 附件另有 `Cleo-linux-x64.deb.sha256` 校验文件。
  本地构建的完整便携包可解压到用户可写目录运行；系统需允许 Electron 的用户命名空间 sandbox。
  不会自动添加 `--no-sandbox` 或修改系统安全设置。
- Windows：双击 EXE 安装向导，默认安装到 `%LOCALAPPDATA%\Programs\Cleo`，无需管理员权限。
  轻量安装器先下载主程序及运行环境，验证成功后安装并创建开始菜单入口。
  准备过程通常需要数分钟，向导会逐步显示当前步骤、下载大小和 Python 依赖安装进度，可随时取消；
  取消会清理已下载和未完成的文件。失败时提示出错的步骤，详细记录在 `%TEMP%\Cleo-install.log`。
  原有源码安装脚本也支持联网准备；桌面内更新使用统一版本切换流程。

macOS 尚未通过 Apple 公证。如果系统提示无法验证安装器或应用，先点「完成」，在确认包来自
官方发布后进入「系统设置 → 隐私与安全性 → 仍要打开」并确认。
参见 [Apple 操作说明](https://support.apple.com/102445)。安装器不会移除隔离属性或关闭 Gatekeeper。
基础运行环境由安装器准备，应用不再自动弹出依赖安装向导；Docker 和独立桌面等可选功能，
以及运行环境修复，仍可从设置中手动打开。

macOS/Linux 便携包通过各自的 manifest 选择更新，校验平台、架构、长度和 SHA-256 后，
与 Windows 共用进化构建区、版本切换交易和独立恢复控制器。普通更新及进化入口复用同一安装包，
不会互相覆盖本地候选构建。未保存的进化需要先处理；切换失败恢复原程序及源码基准，保留当前用户数据。
旧 POSIX 安装器继续保留用于兼容；`.deb` 安装不会尝试自更新系统目录。
联网程序包使用 `schema_version: 2`、`evolution_protocol: 3`，新版客户端会先准备依赖再允许切换；
旧版客户端会拒绝不认识的格式，首次迁移需运行新版图形安装器。协议 2 的完整包仍可由新版读取。

发布附件须成组上传：

| 目标 | Manifest | 校验文件 |
| --- | --- | --- |
| Windows x64 | `release.json` | `Cleo-windows-x64.sha256` |
| macOS ARM64 | `release-macos-arm64.json` | `Cleo-macos-arm64.sha256` |
| macOS x64 | `release-macos-x64.json` | `Cleo-macos-x64.sha256` |
| Linux x64 便携包 | `release-linux-x64.json` | `Cleo-linux-x64.sha256` |

各 manifest 的版本必须与对应包内 metadata 一致。不得把某个平台的 manifest 重命名成另一个
平台的清单；客户端会拒绝不匹配的包。Linux `.deb` 附件由包管理器安装，不使用便携包的 manifest。
EXE 与两个 PKG 各自附带同名加 `.sha256` 的校验文件；发布同时包含精简程序包和轻量安装器。
附件由发布工作流统一校验、上传；无需上传 Python、Node、SDK 或 node_modules 的独立包。

## 验证

`Desktop platforms` CI 分别在 Windows x64、macOS ARM64、macOS Intel、Ubuntu x64 上构建
原生安装包，实际执行 EXE、PKG、DEB 安装，再用独立的临时用户目录验证安装后的程序能
渲染窗口并连接内置后端。仅渲染出错误页面不能通过验证。
发布门禁只覆盖依赖、编译、打包、包完整性和基本启动，不要求具体按钮或产品功能存在。
Python、Node 和界面功能测试保留供开发时按需运行，不阻止主动增删功能的版本发布。
自动修复先运行 `npm --prefix ui run check:release`（仅编译），不能为了旧功能测试恢复已删除功能。
产物与启动截图作为 Actions artifacts 保存，不自动发布 Release。macOS runner 标签来自
[GitHub 官方 runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

Windows 本机的模拟路径测试不代替 macOS 原生运行结果。查看 PR 的矩阵任务及 artifacts，
确认对应目标的构建与启动状态后再发布。发布工作流再次核对标签、版本、依赖快照、附件和 SHA-256。
