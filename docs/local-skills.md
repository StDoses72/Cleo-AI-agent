# 开发会话中的本地 skills

[English](local-skills.en.md)

Cleo 在加载开发会话或选择新任务的原生 Claude/Codex harness 时发现本机 skills。
输入 `/gri` 等名称前缀筛选，用方向键与 Enter/Tab 或鼠标选择命令，再补充参数并发送。
选择命令只插入输入框，不会直接提交任务；输入法组词期间不会误发送。

条目显示所属 harness 和用户／项目范围，悬停可查看实际路径。
例如 `/eli5 explain recursion` 会读取对应 `SKILL.md` 及其资源目录信息并加入 provider 请求。
会话保留调用、来源路径和加载的指令，便于查看。

## 支持的目录

- Claude：`<Cleo 数据根目录>/data/claude/skills` 及项目 `.claude/skills`。
- Codex：`<Cleo 数据根目录>/data/codex/skills`、`~/.agents/skills`，以及项目 `.codex/skills` 和 `.agents/skills`。
- 用户级目录与 harness 进程实际使用的 Cleo 专用目录一致；本机 `~/.claude`、`~/.codex`（或 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`）中的 skills 会在首次使用时复制进 Cleo 目录，菜单列出的是 Cleo 中的副本。
- 项目发现从工作目录向上直到 Git 根目录。每项 skill 使用包含 `SKILL.md` 的独立目录；支持 `.system` 子目录，并解析、去重符号链接。

内置命令保留原名；重复或保留名称使用稳定的 `/skill:name:id` 命令。
菜单排除 `user-invocable: false` 项目；缺失、空白或不可读的文件不能调用，发现过程不会修改已有 skill 文件（仅按上文补充导入本机 skills）。

## 使用范围

菜单支持原生 Claude/Codex 开发会话。安装 skill 后重新打开会话可刷新列表。
普通聊天、进化会话、其他 ACP harness、插件注册表发现及跨 harness 复用不在菜单范围内。
加载指令仍遵循当前 harness 权限，不模拟所有厂商专用执行选项。

Claude 原生连接启用 `setting_sources=["user", "project"]`；Codex 保留原生发现与触发规则。
菜单的可调用过滤不会关闭原生运行时中的自动触发技能。
