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
| `search_long_term_memory` | 检索两个空间的 active 长期记忆，保留 evidence |

Chat 使用 LangChain 封装；productivity 使用同一组方法的 stdio MCP 封装。
用户提到历史讨论时，agent 可以先搜索，再读取选定会话，按项目和 thread 引用来源。
历史内容是参考证据，不能作为当前指令或权限。

## DreamAgent 整理写入

整理与历史检索使用不同投影：现有 `compact.json` 和检索接口保持兼容，DreamAgent
在校验同一事件来源后生成完整正文投影。它合并有可靠 ID 的连续终端片段、复用块内
完全相同的正文，并省略已知用量通知；不会摘取或截断工具正文。凭据脱敏及内联媒体
省略仍适用，超长记录按字符边界拆分，保留来源引用。

每个模型调用使用独立上下文，输入包含一个块、有限既有记忆和前块摘要。模型只返回
JSON；程序校验结构和来源引用，再负责存储及完成状态。没有额外的语义复核模型。
对于包含 `memories` 或 `persona` 集合的模型结果，顶层多余的 `confidence`、
`importance` 会被忽略，不会作为单条记忆的默认评分；条目分值和其余结构仍严格校验。
API 使用配置中的整理模型；订阅 runtime 每块新建会话，`dream_extract` MCP 不提供
记忆写入或读取整份会话的工具。

事件块采用 `o200k_base` 的 20,000 代理tokens预算，同时限制在64,000 UTF-8字节内；
模型指令与输入内容合计最多90,000字节。代理分词不是各provider的精确计量，框架
消息包装另有少量开销。API输出最多使用profile的 `max_tokens` 与20,000中较小的值；
订阅runtime的输出额度由其CLI控制。
首次使用tokenizer可能需要下载其词表；下载失败会保留进度并报告错误，不回退到
不受限制的整份会话读取。实际块数随内容、包装和字节上限变化。

会话目录的 `dream.json` 是持久恢复状态，记录已提交事件游标、前缀 hash、固定快照和
已完成块结果。失败重试复用已完成块；全部块成功后才开始幂等写入。写入中断后仍可
重放相同结果；只有 Markdown 与来源记录成功后才标记完成。项目 `.dream.lock` 用于
跨进程串行发布，进程结束会释放系统锁。两者是运行数据，不是临时备份。

会话继续追加时，先完成已固定的快照，新事件留在待确认队列；下一轮仅处理新增事件。
若旧事件被修改则拒绝跳过旧证据。已有完成标记继续有效；没有新游标的旧会话在下一次
需要整理时，从头建立恢复状态。已有 Markdown 叙述保留，新的自动段展示至多100条
近期或高重要度记忆，完整条目仍在索引中。

## 数据与分页

- 会话文件、项目归属和 DreamAgent 的写入范围保持原状，无需迁移或复制记忆。
- 只读取 Cleo 已保存的历史；外部客户端尚未导入的原生会话不在范围内。
- 活跃会话可读取已持久化的事件。读取不会触发 DreamAgent 或写入 compact。
- 历史搜索复用 compact 的词法分块和评分；compact 缺失或过期时，从事件构造临时投影。
- 消息和工具记录沿用 compactor 的脱敏、图片引用与工具负载省略规则，不是未经处理的原始日志。
- `read_thread(view="summary")` 的 summary 指有效 compact 投影；不可用时返回
  `summary_unavailable`，可改读 `messages`。
- 消息续读游标固定事件上界；后来追加的消息只会出现在新读取中。源内容变化会返回
  `stale_cursor`。通过 session ID 重新解析项目位置，因此移动后仍可读取。
- 读取每次最多三个 6,000 字符片段，`content_offset` / `continued` 标识长记录的分段。
- 搜索每次最多扫描 50 个 thread、返回 20 个命中片段，每段最多 1,000 字符。
  结果按页内相关度、更新时间排序；`truncated` 提示需要读取 thread 获取上下文。
- 列表和搜索返回 `partial`、`next_cursor`。必须继续游标才能判断完整范围有无命中；
  搜索分页不是整个历史库的事务快照，期间新建的会话应重新查询。
- 长期记忆返回最多 20 条、每条正文最多 1,000 字符，并标记截断；evidence 保留源事件位置。
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
