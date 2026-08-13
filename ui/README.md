# Cleo Desktop

Cleo Desktop 是独立 Electron 应用。Renderer 只依赖 `CleoClient` 协议；生产运行通过安全
IPC 连接随应用打包的 Python runtime，不依赖系统 Python 或源码仓库。

## 源码运行

```powershell
npm install
npm start
```

开发模式使用当前源码仓库中的 Python 环境和配置。

## 干净打包

```powershell
npm run package:portable
```

该命令调用仓库顶层 `scripts/build-release.ps1`。打包器不属于 UI：它负责组合独立桌面客户端、
Python 后端和运行时。构建不会复用 `ui/node_modules`、系统 Python site-packages 或旧发布目录，
会在仓库顶层隔离临时目录中执行全新的 `npm ci`，通过 `uv` 下载独立 Python 3.12 runtime、
安装 Cleo 及依赖，并把 Node、agent-browser 和首次启动默认文件一起打入应用。

产物：

- `../release/Cleo/Cleo.exe`：解压后的独立应用
- `../release/Cleo-windows-x64.zip`：用户下载包
- `../release/Cleo-windows-x64.sha256`：下载校验值
- `../release/release.json`：构建元数据

运行：

```powershell
..\release\Cleo\Cleo.exe
```

## 下载与安装

最终用户只下载预构建 ZIP，不在用户机器上安装 Python/npm 依赖：

```powershell
..\scripts\download.ps1 -Launch
```

下载器会自动重试临时网络错误，并在同一次运行中续传；完成后等待按 Enter 关闭。
自动化调用可传入 `-NoPause`。

安装当前仓库构建的包：

```powershell
..\scripts\download.ps1 -PackagePath ..\release\Cleo-windows-x64.zip -Launch
```

更新时重复运行同一命令。下载器会先验证 SHA256，再原子替换程序目录；配置、会话和记忆保留在
`%LOCALAPPDATA%\Cleo`（首次启动会迁移旧 `%APPDATA%\Cleo` 数据）。下载内容是完整桌面应用，不是单独的后端 CLI；最终 `Cleo.exe` 安装到
`%LOCALAPPDATA%\Programs\Cleo`。

模型通过应用内“设置 → 模型”管理，可填写 provider、模型名称、API Key、Base URL 和上下文长度，
并选择用于 Cleo、DreamAgent 或两者。API Key 只保存在本地配置，读取接口不会回传原值。

## 验证

```powershell
npm run typecheck
npm run smoke
npm run smoke:real
npm run smoke:packaged
```

`smoke` 使用确定性 mock 检查 UI；`smoke:real` 检查源码模式真实 IPC；
`smoke:packaged` 检查带独立 Python runtime 的最终应用。
