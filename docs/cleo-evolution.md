# Cleo 本地进化

## 使用流程

1. 顶部始终显示当前程序身份；点击版本入口可切换正式 Release 或最近保存的本地版本。
2. 直接在聊天框选择 harness、模型和思考深度，描述需求。首次自动准备源码与工具，完成修改后自动检查构建。
   用户不需要手动准备或构建；错误与重试显示在顶部。切到其他页面也不会跳过完成后的自动构建。
3. 常驻操作栏固定保留「应用／保存／放弃修改」。检查成功后应用可用；重启查看效果后保存可用。
   继续修改会使旧构建失效，必须重新检查和应用后才能保存，避免保存未应用的源码。
4. 保存时可选填名称，默认用本地保存时间标识。下一次保存成功后替换上一次保存的程序，基础版本仍保留。
5. 放弃修改先确认，回到本轮起点；尚未应用的修改不重启，已经应用的修改通过可见重启流程回退。
   聊天、记忆、配置不恢复为旧快照。准备中、修改中和构建中禁用版本变更操作。

进化页不再显示左侧功能栏，代码面板默认收起，可从顶部按需展开。
正式版本下载放在版本弹窗，贡献与 PR 放在更多菜单；独立恢复入口始终可见。

本地保存不会创建 GitHub Release。普通用户可通过 PR 贡献，维护者在 GitHub
决定合并和发布时机。选择旧源码后重新构建，会使用该程序内嵌的源码快照，
而不是复用另一版本的工作区。

## 数据与恢复

所有程序使用同一 CLEO_HOME 和 Electron userData。切换版本只改程序，
不覆盖用户数据。应用前备份作为意外损坏的留存副本，不提供随版本还原数据的选项。
旧事务中的 restore 字段被忽略。

控制目录位于 Electron userData/evolution：

- builds：工作区基础版本、当前构建和最近一次保存；保底程序始终额外受保护。
- source：当前迭代源码；source-history-* / source-recovery-*：保留的旧工作区。
- tools：私有构建工具，不修改全局安装。
- backups：应用前的数据留存副本。
- state.json：程序选择、workspaceBase、latestSaved、iteration.base、savedAt/name、候选构建、清理队列和启动事务。
- protected.json：版本控制与恢复模块的源码校验。

恢复进程在原程序退出后备份、切换和检查启动状态。保底入口不依赖可变的主界面或
Python 服务。程序副本在 Windows 上通过原生文件复制、其他平台通过 original-fs 复制，
避免把 app.asar 错误地展开成虚拟目录。保底程序不自动清理。

## 版本保留与清理

通常只保留工作区基础版本、当前修改和最近一次保存的本地版本；同一程序兼任多个角色时只存一份。
连续保存不会改变最初的 workspaceBase；新一轮未保存修改仍可回到上一次满意的版本。
显式选择其他版本会更新工作区基础版本。独立保底程序不删除，因此基础版本与保底不同时会多留一份。

完成新构建后清理被替代且未应用的构建；应用期间暂时保留旧程序，直到新程序报告启动成功。
新的保存成功后清理上一次保存，恢复时需要的基础版本除外。新开发包首次导入也先保留旧程序，
待启动成功后清理。Windows 占用或路径异常导致的删除失败会进入队列，下次启动或操作重试。
清理仅针对控制目录 builds 下的程序，识别并回收未登记的 UUID 构建残留；不删除用户数据、数据备份、
源码历史或工具缓存，因此总磁盘占用仍可能超过三份程序大小。

## Harness 与 MCP

进化页面复用开发聊天框的 harness/model picker。
Codex 使用 workspace-write / deny_all；Claude 使用 acceptEdits；
ACP 保留 harness 自己的权限控制，不发送其不支持的 sandbox 参数。
这些 harness 的隔离能力不同，不能把原生权限模式描述成统一的系统级隔离。

记忆 MCP 使用 Python -I 启动，再显式加入 Cleo 包路径，避免用户 Python 包或
PYTHONPATH 引入不匹配的 DLL。该修复覆盖 Codex、Claude 和 ACP 的 MCP 启动参数。

## 程序包与升级

Release manifest 的 evolution_protocol: 2 表示程序切换保留当前数据；
不接受旧协议发行包。启动不会自动下载或覆盖所选程序。

本机开发包可以通过 --cleo-import-bundle 显式导入为可选择的本地版本。
重复打开同一包不会覆盖用户后续的版本选择。旧基准程序与用户数据始终保留，
原工作区存入 source-history-*。

## 窗口启动与退出

面向用户的 Cleo 主界面、版本切换控制器和恢复界面统一由 evolution-launch.mjs 启动。
这些进程不设置 windowsHide，否则 Windows 会隐藏恢复进程的第一个原生对话框，
留下一个等待用户操作却看不见窗口的进程。后台 Python、Git 和构建工具继续静默启动。

独立恢复窗口的取消或关闭会结束恢复进程；正常关闭主窗口会先结束后端再退出应用。
应用和已应用修改的放弃操作由当前受保护的启动代码创建独立重启窗口；旧程序收到窗口已显示的握手后才退出。
控制器等待主界面与后端就绪的确认，不能仅凭进程创建成功关闭进度窗口。
启动失败会先停止失败程序，再尝试上一个程序及保底程序，数据始终保留。
所有尝试失败后进度窗口转为持续可见的恢复入口，取消版本选择也不会自动退出该窗口。
保存本地版本不重启。应用内打开恢复选择时也保留原窗口，确认版本后再开始受控重启。

## 验证与边界

- npm --prefix ui run test:evolution：保存、放弃、连续应用、源码恢复和包导入。
- npm --prefix ui run smoke:evolution：无侧栏布局、多 harness、三按钮状态、直接发送后自动准备与构建、保存和选择版本。
- node ui/tests/evolution-handoff.smoke.mjs：真实 Electron 故障注入，验证可见握手、自动回退和所有程序失败后的持续恢复窗口。
- npm --prefix ui run smoke:evolution-baseline：真实 Electron 中复制 ASAR。
- npm --prefix ui run smoke:evolution-recovery：破坏主程序后选择可用程序，核对当前数据。
- node ui/tests/evolution-recovery-window.smoke.mjs：Windows 原生恢复窗口可见，关闭后进程退出。
- node ui/tests/desktop-close.smoke.mjs：真实打包主窗口关闭后无 Electron/Python 子进程残留。
- tests/integrations/smoke_packaged_memory.py <bundled-python>：真实打包 MCP 握手。
- pytest tests/desktop tests/integrations/test_memory_mcp.py：后端会话和 MCP 回归。

测试不创建真实 PR 或 Release；真实模型完整自修改与发布流程仍需实际使用验证。
任意自改代码的数据格式兼容性不能自动证明；任务提示要求向后兼容，
版本切换本身不执行数据降级或格式转换。
