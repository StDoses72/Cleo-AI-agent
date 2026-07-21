# CastMind 记忆系统复盘与 Cleo 迁移决策

日期：2026-07-20

## 证据边界

本次复盘基于本机 `D:\Supremium\castmind-backend-python-master` 的 2026-07-17
交接副本、背景设计稿、实现、测试和运行数据。该副本没有 `.git` 目录，因此无法可靠
重建 commit、作者和精确 diff；下面的演进顺序以文档日期、交接记录和实际代码为准。

交接数据中只有两个默认 workspace 演示线程（“1+1是多少”和“请帮我提交模温计算”）。
SQLite 中 `memory_entries`、`memory_evidence`、`memory_consolidations` 均为 0；两个线程
已建立 RAG 索引，但尚未由 DreamAgent 整理。因此不把这批演示业务数据导入 Cleo。

## CastMind 做成了什么

### 2026-07-13：从全量重喂转向分层记忆

早期链路是 `messages.json -> DreamAgent -> AGENT.md`。设计稿识别出四个关键问题：

- 每次整理都重新读取整段线程；
- 文件读取、日志、命令输出和模型元数据占据主要上下文；
- 前端清洗与 DreamAgent 输入不是同一条链；
- 多个 dirty source 会在一次 Agent 调用里累积噪声。

由此形成 L0 原始记录、L1 确定性压缩、L2 episode、L3 Dream 提炼、L4 长期记忆
的分层设计。第一版实际批准的是较小闭环：保留 Human/AI 正文，合并 tool call/result，
省略文件读取正文，保留结构化工程结果，并让 DreamAgent 只读 compact 文件。

### 2026-07-16：对话语义检索闭环

实现增加 BGE 中文 embedding、Qdrant workspace 过滤和 CrossEncoder reranker，并做过
一次真实 smoke check。它证明链路能运行，但没有提供足以确定业务拒绝阈值的数据。

### 2026-07-17：三层可运行体系

交接版本形成三种互补存储：

1. 完整原始对话，用于审计、重放和失效校验；
2. SQLite 原子长期记忆，带 category、scope、fingerprint 和 evidence；
3. Qdrant 压缩对话索引，用于按需找回未进入长期记忆的具体讨论。

关键工程原则已经落地：compact source hash、workspace-bound 工具、RAG/Dream 独立
版本状态、task 更新时幂等替换索引，以及检索结果回到当前 compact 源重新校验。

当时明确未完成的内容包括：召回拒绝阈值校准、真实模型/Qdrant 集成测试、增量
chunk 索引、孤立 point 回收、混合检索、消息级 Dream 游标、lease、运行审计表和
preview/dry-run API。

## 迁移取舍

| CastMind 能力 | Cleo 决策 | 原因 |
|---|---|---|
| 原始消息完整保留 | 保留 | 原始层继续是唯一权威记录 |
| 确定性 compact 投影 | 保留并泛化 | 先规则降噪和脱敏，不额外消耗 LLM |
| tool call/result 合并 | 保留 | 保住因果关系和 message evidence |
| source hash 失效校验 | 保留 | 防止旧索引和新原文错配 |
| SQLite 原子记忆与 evidence | 保留 | 让长期记忆可去重、可检索、可回查 |
| workspace-bound 检索工具 | 改为 project-bound | Cleo 的隔离边界是 project |
| Qdrant + BGE + reranker | 暂缓 | 需要 Docker、两个模型、校准集和运维；Cleo 当前是轻量 CLI |
| 历史语义检索 | 改为 SQLite + 词法排序 | 零新增服务，先提供可解释的高确定性召回 |
| FastAPI 后台 scheduler | 改为保存时建索引、退出时整理 | 符合 CLI 生命周期，不引入常驻服务 |
| 三 workspace 自动提升 reusable | 不迁移 | Cleo 是个人通用 Agent，跨项目自动泛化更容易泄漏边界或放大错误 |
| CastMind 工程脚本白名单 | 不迁移 | Cleo 保留任意结构化 JSON；未知文本有界截断 |
| message 游标、lease、多 Dream chunk | 暂缓 | 交接时仍是设计稿；当前 Cleo 线程规模尚无证据需要这套复杂度 |

## Cleo 融合后的数据流

```text
LangChain messages
  -> memory/thread_objects/<thread>.json       完整、权威、原子写入
  -> memory/compact_threads/<thread>.json      规则压缩、脱敏、source hash
  -> memory/memory.sqlite3
       |-> conversation_chunks                 项目绑定的历史片段
       |-> memory_entries + memory_evidence    原子长期记忆与证据
       `-> memory_consolidations               Dream 写入记录
  -> memory/projects/<project>/MEMORY.md       人可读投影 + 原子记忆索引
```

`memory/memory_state.json` 单独记录 raw source version、hash、Dream 状态、失败次数和
最后成功版本。相同 source hash 再次退出时会跳过 Dream；失败不会推进完成状态。

主 Agent 获得两个 project-bound 工具：

- `search_long_term_memory`：查询稳定事实、决策、约束、纠错和行动项；
- `search_conversation_history`：查询未必值得长期保存的历史讨论细节。

DreamAgent 不再获得 raw reader，只能读取 hash 校验通过的 compact source。写入原子
记忆时 evidence message ID 必须在该 source 中存在；写完 Markdown 后还必须显式调用
完成工具，否则本次运行视为失败。

## 后续升级条件

只有当本地词法检索在真实 Cleo 历史上出现稳定的同义改写漏召回时，再引入 embedding。
届时先建立带正样本、普通负样本和困难负样本的校准集，记录 Top-1 分数及 Top-1/Top-2
分差，并优先优化错误记忆注入率。没有校准数据前，不设想当然的语义分数阈值。

当单个 compact thread 经常超过模型输入预算，或中断恢复造成明显重复成本时，再实现
消息级游标、overlap、多 chunk Dream 协议与 lease。升级时应继续维持三个不变量：原始
记录不被压缩器修改、证据 ID 可回查、失败不推进游标。
