# 0017. 电脑操作分三种目标并由 agent 选择；电脑页只显示正在使用的那一种；用户的浏览器经 Cleo 扩展在后台标签页中操作

- **Status**: Accepted
- **Date**: 2026-11-21

## Context

Issue #160：把浏览器与 Computer Use 分成三部分——内置浏览器、用户已经打开的浏览器、完整桌面控制——让用户知道 AI 正在操作哪里，并且在操作用户已打开的浏览器时**不干扰原生鼠标键盘**（硬性要求）。

决策前的状态：

- `ui/electron/computer/broker.mjs` 的会话只有两种模式 `browser | host`，由用户在电脑面板顶部的两段开关里切换；本机模式需要用户在面板中确认，模型也可以调用 `request_desktop_control` 申请。
- 内置浏览器（ADR 0003）通过 Electron 的 `webContents.debugger` 发送 DevTools 协议命令：不移动真实指针、不抢焦点。
- 没有任何连接用户自己浏览器的通道。Chrome 136 起不再允许对默认资料目录开启 `--remote-debugging-port`；Chrome 144 起的 `chrome://inspect` 远程调试开关每次连接都会弹出确认。

与用户确认 UX 时用两轮交互样例（Artifact）对比了方案，用户的决定：

1. 不要常驻的三段模式选择；**电脑页只显示 agent 当前使用的模式**（样例中的「方案 A：跟随式电脑页」）。另外两个方案——在对话里内嵌卡片、在输入框上方放控制条加浮窗——被否决。
2. 连接用户浏览器参照 Codex 的浏览器扩展方案；范围是整个浏览器；电脑页对用户浏览器只显示目标卡片，不放实时画面。
3. 连接、已允许的网站、紧急停止快捷键集中到「设置 → 电脑操作」。

实测（Chromium 1208，原始 DevTools 协议，两个标签页在同一窗口）：对 `visibilityState === "hidden"` 的后台标签页，`Page.captureScreenshot`、`Input.dispatchMouseEvent`、`Input.insertText`（含中文）、`Input.dispatchKeyEvent` 和滚轮都能正常工作，前台标签页始终保持在前。扩展里的 `chrome.debugger` 用的是同一套协议。

## Decision

**三种模式，由 agent 选择。** 会话的模式为 `browser`（内置浏览器）、`user`（用户的浏览器）、`host`（本机电脑）。每种模式的工具目录里都有 `computer_mode`（`ui/electron/computer/tools.mjs`）：

- 切到 `builtin_browser`：立即生效。
- 切到 `user_browser`：要求扩展已连接，不需要单独确认；每个网站第一次被读取或操作前，会在对话里询问用户（仅这一次 / 始终允许此网站 / 所有网站 / 拒绝）。`about:blank` 和新标签页不询问；`chrome://` 等非 http(s) 页面一律拒绝。
- 切到 `desktop`：沿用原来的授权流程，由用户在对话里确认。`request_desktop_control` 作为旧名称继续可用。

用户在界面上不再切换模式。授权跟随一轮任务：回合结束后，模式回到内置浏览器，本机授权撤销，「仅这一次」的网站授权清空。

**用户的浏览器。** 由 Manifest V3 扩展（`ui/electron/computer/extension/`，权限为 `debugger`、`tabs`、`tabGroups`、`nativeMessaging`、`alarms`，不申请任何网站权限）和 native messaging host（`native-host.mjs`）组成。host 用 Cleo 自己的可执行文件以 Node 模式运行，通过 `ComputerBridge` 新增的 `link` 长连接接入（命名管道加令牌，不开 TCP 端口），其余请求仍是一次一连接。

页面操作全部是对单个标签页发出的 DevTools 命令，复用内置浏览器的输入实现（新抽出的 `cdp-input.mjs`），因此不移动真实指针、不切换用户正在看的标签页、不经过剪贴板。agent 新开的标签页在后台打开，并放进「Cleo」标签组；Cleo 只能关闭自己打开的标签页。

以下情况都会让 AI 停下，不会悄悄改用别的标签页：

- 用户在 agent 的目标标签页里有真实输入（页面内只对 `isTrusted` 事件计数，并排除 Cleo 自己刚发出的输入）：控制权转给用户，与内置浏览器的接管语义相同。
- 目标标签页被关闭：后续调用会失败，并要求 agent 询问用户；用户可以在电脑页重新选择标签页。
- 用户在浏览器的调试提示条上点「取消」，或扩展断开连接：取消本回合。
- 没有回合在使用用户浏览器时，Cleo 主动 detach，浏览器的调试提示条随之消失。

扩展以「加载已解压的扩展程序」方式安装。`manifest.json` 中固定的公钥决定了扩展 ID（`amhjfgfphlnaohlaoakngcopnpklaocd`），host 清单的 `allowed_origins` 只允许这一个 ID。Cleo 把扩展文件和 host 写到用户数据目录的 `browser-extension` 下，并按用户注册：Windows 写入 HKCU 中 Chrome、Edge、Brave、Chromium 各自的键，macOS / Linux 在各浏览器的 NativeMessagingHosts 目录写入清单。用户第一次连接之前什么都不写；连接过之后，每次启动都会刷新路径，保证升级后仍然有效。

**电脑页只显示当前模式。** `ComputerPanel` 的内容：

- 模式头：模式名、目标、当前阶段。
- 该模式的主体：内置浏览器显示页面本身；用户浏览器显示目标标签页卡片和标签页选择器；本机电脑显示紧急停止快捷键和耗时分解。
- 接管 / 交回 / 停止，以及本段操作记录。

回合结束后，电脑页改为本次各段的摘要（模式、目标、步数、耗时）。授权和网站确认显示在对话的输入框上方（`ComputerApprovals`），不放在电脑页。

**阶段与耗时由 broker 记录。** 每次调用记为一个步骤，按模式分段。阶段包括：思考中、正在查看、正在操作、正在等待、等你确认、已暂停、未完成。耗时分为三类：

- 思考：两次调用之间的间隔，上限 5 分钟，模式切换时从中拆开。
- 执行。
- 等待：各种 `*_wait`。

本机状态条直接显示当前阶段和步骤，暂停或等待用户时变为琥珀色，失败时变为石墨色。

**本机启动应用只等能观察到的信号。** 原来按下 Win 键后固定等待 0.8 秒；现在改为等开始菜单搜索框获得前台，最多 1.5 秒。按下回车后，再等新窗口来到前台，最多 8 秒，并把窗口标题返回给 agent，省掉一次「等待再截图」的往返。搜索结果列表没有可观察的信号，所以仍保留 1 秒的固定等待。

## Alternatives considered

- **常驻三段模式开关（第一轮样例）。** 用户认为与「agent 自己选」重复，否决。
- **对话内嵌卡片 / 输入框上方控制条加浮窗（第二轮样例的方案 B、C）。** B 会把长任务的对话拉长，内置浏览器的画面也太小；C 的细节需要点开才能看到，浮窗还会遮住对话。用户选了 A。
- **Chrome 144+ 的 `chrome://inspect` 远程调试开关加 `--autoConnect`。** 不需要装扩展，但每次连接都要用户点允许；Edge 是否支持未经验证；而且会在本机开放 DevTools 端口，任何本地进程都能请求连接。用户要求参照 Codex 的扩展方案，否决。
- **用 `--remote-debugging-port` 重启用户的浏览器，或复制 profile。** Chrome 136 起对默认资料目录无效；复制 profile 违反 issue「不得复制 cookie、凭据或 profile」的要求。否决。
- **扩展内用 content script 模拟点击（`element.click()`），不用 debugger。** 事件不可信，覆盖不了 hover、拖拽、按键和输入法；也无法给后台标签页截图。否决。
- **切换到用户浏览器时先整体确认一次，再按网站确认。** 两层确认重复；单独的「使用浏览器」确认不保护任何东西，真正敏感的是网站本身。否决。

## Consequences

- 在用户的浏览器里，用户可以一边继续用鼠标键盘，一边让 agent 在后台标签页工作。代价是 Chrome 在连接期间会显示调试提示条，这是浏览器自己的提示，无法去掉。
- 扩展只能以开发者模式加载；上架 Chrome 网上应用店 / Edge 外接程序之前，用户需要手动加载一次。上架后只需更换安装入口，扩展 ID 由公钥决定，不会改变。
- 没有 Firefox 支持（WebExtensions 没有 `chrome.debugger`），设置页明确标注「不支持」。
- 同一时间只连接一个浏览器：先连上的那个保持连接，另一个的 native host 被拒后退避重试（2 秒起，最长 60 秒）。每次新连接都会带上新的代号，旧连接留下的截图和坐标一律作废，避免 Chrome 与 Edge 的标签页编号互相冲突。
- link 使用独立令牌，写在单独的 `link-*.json` 描述文件中；工具进程只拿到工具令牌，无法冒充扩展。
- 网站授权按页面执行时的地址核对，而不是按询问时的地址：
  - 等待用户回答期间页面换了网站，旧的回答不适用，会就新网站重新询问；
  - 截图或读取期间页面换了网站，结果丢弃；
  - 截图记下当时的网站，点击、输入等操作只在页面仍是那个网站并且已获授权时执行。
  
  这样，「授权 A 网站」不会被用来截取或操作 B 网站。检查与执行之间仍有毫秒级的间隙，这是协议本身的限制。
- 接管检测脚本运行在独立的 JavaScript world 里，页面脚本既调用不到也改不了它。它不覆盖页面内的 iframe。Cleo 自己的输入结束后 600 ms 内，用户的输入不计为接管，这是为了区分「Cleo 的输入」与「用户的输入」所做的取舍。
- 本机启动应用时，如果开始菜单搜索没有出现，会按 Esc 关闭菜单并报错，不会把应用名输入到当前窗口里。
- 本机授权从「整个会话」收紧为「一轮任务」：后续消息里如果需要再操作本机，会再请求一次授权。
- 「所有网站」授权保存在 `computer-use-ui.json` 中，可以在设置页移除。
- 后续工作：
  - 发布扩展到商店。
  - 前后实测见 `docs/benchmark-computer-use.md`。启动应用一步从 1.87 秒降到 1.38 秒，并省掉一轮「等待再截图」，但完整任务中模型推理占回合时间的 65%–95%，样本也太少，不足以说明整体变快。下一步应减少模型往返，例如不必每个动作后都截图。
  - macOS / Linux 的用户浏览器链路只做了文件注册，尚未实机验证。

## References

- Issue #160；关联 ADR 0003（内置浏览器）。
- 代码：`ui/electron/computer/broker.mjs`、`tools.mjs`、`user-browser.mjs`、`user-browser-setup.mjs`、`native-host.mjs`、`extension/`、`cdp-input.mjs`、`labels.mjs`；`ui/src/components/ComputerPanel.tsx`、`ComputerSettings.tsx`；`cleo/computer/host.py`（`_launch`）。
- 测试：`ui/electron/computer/broker.test.mjs`、`user-browser.test.mjs`、`ui/tests/computer-panel.smoke.mjs`、`ui/tests/user-browser.e2e.mjs`（真实 Chromium 加载扩展），`tests/integrations/test_computer_host.py`。
- 文档：`docs/computer-use.md`。
