# Chat 与 productivity 双向读取

Chat、Codex、Claude 和 ACP productivity 会话使用同一个 `MemoryReader`。
读取范围是当前 Cleo 配置的 memory 根目录，默认覆盖 `non_productivity` 与
`productivity` 的所有项目。`space`、`project`、`session_ids` 是可选的交集过滤条件；
过滤后没有结果不会自动扩大范围。

## 工具

| 工具 | 行为 |
| --- | --- |
| `list_threads` | 按标题、项目或 ID 发现已保存会话，返回 Cleo `session_id` |
| `search_conversation_history` | 检索讨论片段，包括尚未 compact 的会话 |
| `read_thread` | 按 `session_id` 读取消息投影，或通过 hash 校验的 compact |
| `search_long_term_memory` | 兼容名称：只读取两个空间的当前 Markdown 偏好，不读取旧事实库 |
| `read_project_memory` | 读取指定项目的偏好、历史交接快照与 Git 记录 |
| `memory_history` | 只读查看指定项目记忆的 Git 提交 |
| `list_memory_sources` | 列出 Cleo、Codex、Claude 和手动来源，区分安装、配置、历史与记忆可读状态 |
| `browse_memory_source` | 分页浏览原生目录与作用域、格式、版本和原文引用 |
| `read_memory_source` | 按需读取 UTF-8 原文的有界字节页，续页绑定版本 |

Chat 使用 LangChain 封装；productivity 使用同一组方法的 stdio MCP 封装。
用户提到历史讨论时，agent 可以先搜索，再读取选定会话，按项目和 thread 引用来源。
历史内容是参考证据，不能作为当前指令或权限。

## DreamAgent 整理写入

当前实现见 [Markdown 偏好与内嵌 Git](MEMORY_MARKDOWN_GIT.md)。项目 MEMORY.md 是
唯一偏好正文，默认不再提取事实、决策、测试结果或 persona。每块模型返回明确的
old/new 编辑与未解决冲突；程序校验来源、目标和预算，在候选正文中合并，全部块成功
后再发布一个有效版本。手动整理可替换一个有来源时间的简短交接快照。

结构投影继续合并有可靠 ID 的终端片段、复用相同正文并省略已知用量通知，保留工具
的有界摘录并保留结果、状态和原文引用；字符分块、20,000 代理 tokens 和 UTF-8 字节上限保持。模型不能直接写文件，
独立上下文继续通过 API 或订阅 runtime 使用已配置的整理模型，不加载本地语义模型。

版本 2 的 dream.json 记录增量游标及未完成块结果，成功后清理中间候选。旧版本的事实
提取 checkpoint 不作为新偏好证据；旧 Markdown 必须经过显式迁移预览，不能静默
覆盖或重新作为有效偏好加载。历史原文与旧数据库不会在升级时自动删除。

内层 Git 只追踪白名单 MEMORY.md。发布失败保留/恢复旧正文，重复发布不产生额外
提交；不确定冲突候选逐项跳过，其他有效编辑继续发布。历史矛盾条目的 hash 排除标记保持兼容。Git
来源 hash 和会话标识提供回查入口，不再在每条偏好后反复追加 evidence 长串。

## 数据与分页

- 会话文件、项目归属和 DreamAgent 的写入范围保持原状，无需迁移或复制记忆。
- 原有 thread 工具读取 Cleo 历史；跨 harness 工具直接按需读取原生文件，不另建全文副本。
- 活跃会话的持久事件可局部补齐索引。查询不触发 DreamAgent；失效的派生 compact/分块可以重建。
- 历史搜索复用 conversation_chunks。事件序号、文件身份、compact 和索引版本共同判断新鲜度；不变日志不会每次全读和全文哈希。
- 消息和工具记录沿用 compactor 的脱敏、图片引用与工具负载省略规则，不是未经处理的原始日志。
- `read_thread(view="summary")` 的 summary 指有效 compact 投影；不可用时返回
  `summary_unavailable`，可改读 `messages`。
- 消息续读游标固定事件上界；后来追加的消息只会出现在新读取中。源内容变化会返回
  `stale_cursor`。通过 session ID 重新解析项目位置，因此移动后仍可读取。
- 读取每次最多三个 6,000 字符片段，`content_offset` / `continued` 标识长记录的分段。
- 搜索在限定范围内完成相关性排序后分页，每页最多 20 个片段，每段最多 1,000 字符。
  不再按 50 个会话或 1,000 块静默截断；普通词法匹配仍可能扫描范围内所有分块。
- 列表和搜索返回 `partial`、`next_cursor`。必须继续游标才能判断完整范围有无命中；
  搜索游标绑定查询、作用域与可见历史/索引版本；有上限的短期命中 ID 快照过期或变化会明确失效，需重新查询。
- 偏好检索按项目读取最多 30 条有效条目；跨项目结果可受 limit 截断并返回 partial，需缩小范围。
  不伪造每条偏好的事实置信度或事件来源；项目级 Git 历史提供整理来源。
- 已删除的 thread 返回 `not_found`；损坏的事件返回 `read_error` 或带 `errors` 的部分结果。
  底层索引初始化／修复仍由现有存储负责，工具不提供修改会话或记忆的操作。

## MCP 只在 Cleo 子进程内生效

保留名 `cleo_memory` 用于 Cleo 管理的 MCP 服务；不要在用户配置中用同名注册其他服务。

| Provider | 临时接入方式 |
| --- | --- |
| Codex | `CodexConfig.config_overrides` → app-server 的 `--config` 启动参数；服务设为 required |
| Claude | `ClaudeAgentOptions.mcp_servers` → 内联 `--mcp-config`；连接后检查服务状态 |
| ACP | `new_session` / `load_session` 的 `mcp_servers` 参数 |

不调用 MCP 注册命令，不写全局／项目配置文件，不修改用户的 `AGENTS.md`。
工作目录可以是其他仓库，服务仍通过绝对路径和显式 `--memory-root` 读取 Cleo 存储。
配置的 `session_index_path` 通过临时 `--session-index-path` 参数一并传入；chat 使用
相同索引。会话发现遇到缺失或空索引时，从已保存的 manifest 恢复，不把已有历史误判为空。
新建、恢复、Codex fork 和 Claude 重连会重新使用临时配置；进程生命周期交由 SDK 管理。

ACP 的实际加载能力取决于所配置的 agent；协议请求失败会正常向上传播，不会回退到修改
全局配置。通用 ACP 接口没有统一的 MCP 工具清单查询，本项目的协议测试不能替代各 agent
的实机兼容性验证。

临时 MCP 不会添加到独立打开的本地客户端。但是，如果在其他客户端打开同一个原生
thread，仍可能看到其已经保存的工具调用和返回内容。配置隔离不隔离原生会话历史。

独立调试入口：

```text
python -m cleo.mcp.memory_server --memory-root <absolute-memory-directory>
```

运行 `tests/memory/test_reader.py` 和 `tests/integrations/test_memory_mcp.py` 可验证
跨空间读取、分页、恢复接入、真实 stdio 启动与退出，以及客户端临时配置。

## 跨 harness 原生记忆

设置 → 数据与记忆可添加绝对路径的只读来源，或撤销来源读取；配置保存在
`config/memory-sources.json`，独立于 DreamAgent 开关。默认读取有效原生 home。
Codex 暴露 `memories/`、`AGENTS.md` 和原生 JSONL；Claude 暴露项目 `memory/`、
`CLAUDE.md` 和原生 JSONL。自定义目录可手动添加 Markdown 来源。凭据、原生配置、
数据库与锁不作为正文读取项。未知/全局作用域不会伪装成某项目；项目路径过滤仅匹配
原生 metadata 或显式手动绑定。读取页保留原生换行、字节位置和版本，源变化要求重读。

可选协作提示默认关闭，只在启用后传给 harness。它要求按需读取当前项目、保留原始
来源及版本、跳过重复与无变化内容，并使用 harness 自己支持的机制维护记忆。读取
成功或提示已发送不代表同步成功；功能关闭、未知、冲突或读取失败必须反馈。
Codex 生成文件不是稳定写入接口，不能通过直接覆盖它们强制同步。

原生自动更新状态只报告本地配置证据，不保证后台生成已执行。项目/组织策略、会话
条件、MCP 外部上下文资格及额度仍可能阻止生成。实现依据：
[Codex memories](https://learn.chatgpt.com/docs/customization/memories)、
[Claude memory](https://code.claude.com/docs/en/memory)。

## 可重复验证

`python -m scripts.benchmark_memory_projection` 用合成的大工具输出比较完整正文与有界投影，
核对失败、取消、恢复、测试结果和用户约束仍存在，且原始事件不变。
`python -m scripts.benchmark_memory_retrieval --memory-root <全新临时目录> --prepare`
创建 60 个会话、每个 40 轮的合成样本，统计预热后三轮完整分页检索的实际原文读取次数。
可将同一脚本的 `PYTHONPATH` 指向基线 checkout，对同一 fixture 运行对照；脚本不调用模型。

在本次 Windows 验证中，投影输入由 30,236 降至 323 tokens；检索完整日志读取由 186 次
降至 0 次，总耗时约 2.51 秒降至 1.41 秒。耗时依赖机器与缓存，不能外推为所有查询的保证。
`tests/memory/test_retrieval_index.py` 还验证 513 个会话配合 8 项进程缓存，以及变化、损坏、
rewind、移动、删除、重启与发布失败；测试观察真实读取入口，不只拦截投影函数。
