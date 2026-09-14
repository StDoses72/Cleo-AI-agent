# 自动准备进化验收

进化会话收到需求后，先持久化原文和请求 ID，再通过只读分析器选择并读取相关源码。
明确修改需求直接生成和冻结案例；只有影响实现的歧义才等待用户补充。
案例包括对应要求、静态分析及源码行证据、操作条件、预期结果和验证方式。
当前行为未经运行验证时始终标记“尚未验证”。

桌面仅允许携带本轮冻结案例的编辑任务启动；编辑成功结束后，仍调用原有
`EvolutionManager.build()`，依次运行编译、前端构建、回归测试、打包，再比较行为。
新文件 `evolution-requests.test.mjs` 会被现有桌面回归测试发现机制自动纳入。
恢复、版本选择、应用和保存控制器没有改动。

## 验收能力

- 已有 `dream-format` 案例继续使用固定模型输出，在独立临时数据中回放基线和候选程序。
- 自动准备的普通需求案例使用现有 `manual` 类型，不生成 Dream fixture，也不伪造旧版失败记录。
- 通用 UI/交互行为目前没有可靠的内置自动执行器，保持“待人工验收”。构建成功、agent 完成和模型判断都不能将其标记通过。
- 人工通过仍需用户在行为验收区记录实际观察，报告继续绑定候选版本、源码哈希和案例集合。
- 本轮案例和历史回归单独标识；案例、源码或构建变化使旧结果失效。

## 恢复与修正

请求 ID、原文、澄清记录、冻结案例 ID、失败原因和提交记录持久化在独立日志中。
刷新或重启读取同一记录，不重新生成冻结预期，也不自动重发已提交的编辑任务。
冻结日志先写案例 ID，再写案例文件；中途失败继续完成同一批案例。
失败可点击“重试准备原需求”；实现中断可显式选择“沿用案例继续未完成的实现”，继续记录指向原请求，案例不重复创建。

用户可在案例中选择“修正案例”，填写操作、预期和变更原因。原案例保留并归档，修正生成新的案例 ID，旧验收立即失效。
额外案例仍可通过已有“添加验收案例”入口补充。自动重试和编译修复不能重写预期。
纯提问在同一会话内显示只读答复，不调用 begin、编辑器或自动构建。

## 存储兼容性

本次受影响的存储为 `acceptance/suite.json`、`acceptance/report.json` 和新增的
`acceptance/requests-v1.json`。suite 的数组及案例字段、report 的绑定格式均不变；
report 只将人工基线说明明确为“尚未验证”。新增需求信息、历史关系和执行记录放在独立文件中。
识别不了或损坏的文件会报错，不覆盖为空数据。未知字段在新日志读写及案例追加/归档时保留。
不更改 CLEO_HOME、Electron userData、聊天、记忆、配置、技能的存储格式。

`ui/scripts/check-acceptance-compatibility.mjs` 从本机保留的真实 app.asar 提取旧读写器，
全部在临时目录执行“旧数据 → 新版读写 → 旧版读写 → 新版读取”。
包含非空案例、缺少 sourceThread、未知字段、新案例、独立请求日志和非空聊天/记忆/配置哨兵。
当前迭代基础 `local-79f5a2d2-5d99-4cb3-9193-ccdf5fec62b7` 往返通过；旧版追加、归档、比较和人工记录后，新字段与独立日志保留。
基线 `baseline-8f73451a-b184-4ce3-835c-5cab78ff34a9` 和保存版
`local-d103125b-479c-40df-8306-d4c7d4fce021` 尚无行为验收读写器，无法进行同类往返；
不声称这些旧程序具备新验收功能。没有用备份或程序回滚替代数据兼容验证。

## 本轮验证

- 安装的 TypeScript：`node node_modules/typescript/bin/tsc -b`。
- Vite 生产构建：`node node_modules/vite/bin/vite.js build`（存在包体积提示，不影响构建）。
- 验收与编排：`node --test ui/electron/evolution-acceptance.test.mjs ui/electron/evolution-requests.test.mjs`，18 项通过。
- Python 需求分析与现有进化策略：`tests/desktop/test_evolution_planning.py`、`tests/desktop/test_evolution.py`，29 项通过，包含禁止初始化聊天索引、连接关闭及超时恢复。
- Dream、订阅运行时和 MCP 回归：`tests/agents/test_dream.py`、`tests/agents/test_subscription_runtime.py`、`tests/integrations/test_agent_mcp.py`，60 项通过。
- 生产前端界面：`ui/scripts/smoke-evolution-preparation.mjs`，本地 Chrome 隔离环境中 6 个场景通过，使用真实请求存储/编排模块和模拟分析器、编辑器、构建器。
- 8 个受保护程序文件 SHA-256 均与桌面的 protected.json 一致。

本机缺少 Electron 测试二进制且下载失败，原生 Electron smoke 未完成；Chrome 测试不能替代打包后的 Electron 验证。
未调用真实模型完成自修改；真实模型的语义判断和下一轮完整体验需应用后验证。
本轮未手动打包、应用、保存、发布或重启 Cleo，最终打包与可用性由桌面的独立检查决定。

## 应用后验证

1. 在进化会话发送一条新需求，例如“把进化页面的示例提示改为‘描述你想修改的功能’”。
2. 应先看到“正在分析需求并准备验收”，随后出现对应要求、静态证据、操作和冻结预期，再开始编辑。
3. 构建完成后普通案例仍为“待人工验收”；按列出的操作检查界面，再填写观察记录。
4. 刷新会话检查案例 ID 和内容保持不变；纯提问“解释这个按钮，不要修改代码”应只得到答复。

`tests/fixtures/evolution-auto-acceptance-task.json` 是这次开发前由编码助手手工冻结的验收材料，
并不是尚未应用的新功能自动生成的记录。新功能必须在应用后用下一条需求验证。
