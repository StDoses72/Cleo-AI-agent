# 桌面平台支持

v0.3.0 提供以下原生构建目标。各平台必须在对应系统和 CPU 架构上构建；源码支持不代表
当前 GitHub Release 已上传了全部平台的预构建附件。

| 目标 | 程序 | 发布文件 | 用户数据 |
| --- | --- | --- | --- |
| Windows x64 | `Cleo/Cleo.exe` | `Cleo-windows-x64.zip` | `%LOCALAPPDATA%\Cleo` |
| macOS Apple Silicon | `Cleo.app` | `Cleo-macos-arm64.zip` | `~/Library/Application Support/Cleo` |
| macOS Intel | `Cleo.app` | `Cleo-macos-x64.zip` | `~/Library/Application Support/Cleo` |
| Linux x64 | `Cleo/Cleo` | `Cleo-linux-x64.tar.gz`、`Cleo-linux-x64.deb` | `$XDG_DATA_HOME/Cleo`，默认 `~/.local/share/Cleo` |

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

macOS 当前构建产物采用 ad-hoc 签名，用于本地运行和 CI 验证，**不等同于 Developer ID 签名
及 Apple 公证的正式分发包**。v0.3.0 的 macOS 附件以开发签名构建提供；要生成经过公证的
分发包，需要发行者配置 Apple 凭据、签名和公证流程，
并对最终签名后的 ZIP 重新生成校验清单；脚本不会移除 Gatekeeper 隔离属性或关闭验证。
参见 [Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)。

## 安装与更新

- macOS：将 `Cleo.app` 放入可写的 `~/Applications` 或 `/Applications`。只读磁盘映像、
  App Translocation 或无写权限的位置会拒绝更新，原程序保持打开；需要先移动应用。
- Linux：Ubuntu/Debian 推荐 `sudo apt install ./Cleo-linux-x64.deb`，桌面入口随包安装。
  该包正确设置 Electron sandbox helper 的所有权与权限，通过包管理器安装新版进行更新。
  `.deb` 附件另有 `Cleo-linux-x64.deb.sha256` 校验文件。
  便携包可解压到用户可写目录运行；系统需允许 Electron 的用户命名空间 sandbox。
  不会自动添加 `--no-sandbox` 或修改系统安全设置。
- Windows：继续使用现有安装器与 `release.json`，保持旧版更新兼容。

macOS/Linux 便携包通过各自的 manifest 选择更新，校验平台、架构、长度和 SHA-256 后，
使用临时目录中的独立 Node 安装器准备文件。准备失败时不退出应用；准备完成后等待旧进程
退出，以同卷目录重命名替换并启动新版本。启动失败会恢复旧版本；如果恢复也失败，则保留
旧安装并报告其位置。用户数据不在替换目录中，安装结果在下次启动时提示。
macOS 还会验证包内代码签名。`.deb` 安装不会尝试自更新系统目录。

发布附件须成组上传：

| 目标 | Manifest | 校验文件 |
| --- | --- | --- |
| Windows x64 | `release.json` | `Cleo-windows-x64.sha256` |
| macOS ARM64 | `release-macos-arm64.json` | `Cleo-macos-arm64.sha256` |
| macOS x64 | `release-macos-x64.json` | `Cleo-macos-x64.sha256` |
| Linux x64 便携包 | `release-linux-x64.json` | `Cleo-linux-x64.sha256` |

各 manifest 的版本必须与对应包内 metadata 一致。不得把某个平台的 manifest 重命名成另一个
平台的清单；客户端会拒绝不匹配的包。Linux `.deb` 附件由包管理器安装，不使用便携包的 manifest。

## 验证

`Desktop platforms` CI 分别在 Windows x64、macOS ARM64、macOS Intel、Ubuntu x64 上运行
Python、Node 与 Electron smoke。macOS/Linux 还会构建原生包并运行最终包 smoke；手动运行
工作流时同样构建并验证 Windows 发布包。Windows 还验证更新进度与重复启动保护。产物与截图
作为 Actions artifacts 保存，不自动发布 Release。macOS runner 标签来自
[GitHub 官方 runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

Windows 本机的模拟路径测试不代替 macOS 原生运行结果。查看 PR 的矩阵任务及 artifacts，
确认对应目标的构建与测试状态后再发布。
