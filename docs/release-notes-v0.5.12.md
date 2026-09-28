# Cleo v0.5.12

- 修复 Codex 调用独立桌面工具时出现「MCP tool call requires approval, but approval policy is never」的问题。
- 对 Cleo 内置独立桌面的 `computer_tools`、`computer_call` 设置进程内、工具级授权；保留会话审批和沙箱设置，自定义 MCP 与主机操作模式不获得该授权。
- 增加真实 Codex 协议回归测试，覆盖工具搜索、发现、截图调用和显式审批拒绝；可选 Docker 测试连接一次性真实桌面。
- 继续使用 v0.5.11 桌面镜像，保留现有桌面与浏览器资料。仍需要 Docker Desktop。
