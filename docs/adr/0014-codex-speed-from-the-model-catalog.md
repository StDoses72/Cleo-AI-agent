# 0014. Codex 速度档位按模型目录提供；模型不提供已保存的档位时以标准速度运行并保留选择

- **Status**: Accepted
- **Date**: 2026-11-19

## Context

Issue #182：Codex 的速度选项原本只有 Standard 和 Fast（`service_tier` 为 `default` / `fast`），希望在支持的模型上增加 Ultrafast（`ultrafast`）。

决策时已知的事实（2026-11-19 在本机实测）：

- `model/list` 的每个模型带 `serviceTiers`（`id`、`name`、`description`）。旧字段 `additionalSpeedTiers` 已标记为 deprecated。openai-codex 0.170.0 下，`gpt-6.2-sol` 列出 `priority`（名称 Fast）和 `ultrafast`，其余模型只有 `priority`。0.156.0 的目录里没有 `gpt-6.2-sol`，也没有任何模型提供 `ultrafast`。
- 线程上的 `serviceTier` 传 `fast` 时，app-server 记为 `priority`；传 `ultrafast` 时记为 `ultrafast`。
- 给不提供某个档位的模型发这个档位（例如给 `gpt-6-astra` 发 `ultrafast`），请求不会报错，app-server 静默按标准速度运行，线程上的 `serviceTier` 为 `null`。
- 桌面端在会话打开时已经会读取当前 harness 的模型目录，思考深度就是从这份目录里取的（`Conversation.tsx` 的 `selectedModel`）。

## Decision

**档位来自模型目录。** `HarnessModel` 增加 `service_tiers`，元素是 `HarnessServiceTier(id, label, description)`。`CodexProvider` 把目录中的 `priority`（以及旧版的 `fast`）映射为 Cleo 的 `fast`，`ultrafast` 映射为 `ultrafast`，其它 id 忽略。`serviceTiers` 为空时退回读取 `additionalSpeedTiers`。桌面端的模型目录会带上 `serviceTiers`；harness 没有给出这一字段时就省略它，以便和「目录说没有档位」区分开。

**界面按当前模型决定控件形态：**

- 模型提供 Ultrafast：思考深度菜单下方列出 Standard / Fast / Ultrafast 三行。每行是名称加目录里的描述，当前档位打勾。
- 模型只提供 Fast，或者目录没有给出档位（旧版 app-server、读取失败）：保留原来的「快速模式」开关。
- 模型不提供任何档位，且会话没有保存非标准档位：不显示速度控件。

**会话保存的档位是用户的选择，每轮实际发送的档位按当前模型计算。** `CodexProvider._effective_service_tier` 规则如下：

- 模型提供已保存的档位：照发。
- 模型不提供：发 `null`，即标准速度。
- 目录里查不到这个模型：照发已保存的档位。

会话没有指定模型时，按目录的默认模型计算。每个模型最多读一次目录，`list_models` 读到的结果会被复用。保存的档位不会因为切换模型而改变，切回提供该档位的模型时会自动恢复。

**界面把回退说清楚。** 保存的档位不可用时，速度菜单中显示「极速不适用于 GPT-5.6-Terra · 使用标准」，思考深度芯片的附注变为「· 标准」并用警示色。芯片上带有 `data-speed-unavailable`。在菜单里选 Standard 会清除保存的选择。

## Alternatives considered

- **始终把已保存的档位交给 app-server，由它决定。** 实际运行速度与界面显示的不一致，而且 app-server 不会报告这次回退。否决。
- **不可用时改用次一级的档位（Ultrafast 退到 Fast）。** Fast 同样会增加用量；在用户没有选择的情况下换成另一个计费更高的档位并不合适。否决，统一退到标准速度。
- **模型不可用时自动把会话改回 Standard。** 这会丢掉用户的选择，切回原模型后还得重新选。否决。
- **把速度做成独立的芯片。** 会多出一个入口。原来的快速模式开关已经放在思考深度菜单里，这次只替换这一节，不改变菜单结构（「一处一功能」）。否决。

## Consequences

- 只有 openai-codex 0.170 及以上版本的目录会给出 Ultrafast。仓库的 `requirements.txt` 仍锁定 0.163.0，发布 CI 打包的是解析到的最新版本（见 release-ci-dependency-drift）。旧版本下只显示原来的开关，行为与改动前一致。
- Fast 和 Ultrafast 的描述直接使用 Codex 目录里的英文原文（例如「2x speed, increased usage」），因为倍率因模型而异，只有目录能给出准确数字；名称和 Standard 的描述走 Cleo 的语言包。
- 目录读取失败时，会照发已保存的档位。如果模型其实不支持，app-server 仍会静默按标准速度运行，这一轮界面显示的档位可能与实际不符。
- Claude 和 ACP 不提供速度档位（`Capability.SERVICE_TIER` 只属于 Codex），不受影响。

## References

- Issue #182
- `cleo/integrations/harnesses/codex.py`：`_catalog_service_tiers`、`_effective_service_tier`、`_start_turn`
- `cleo/harnesses/control.py`：`HarnessServiceTier`、`HarnessModel.service_tiers`
- `ui/src/components/RuntimePicker.tsx`：`speedState`、`EffortChip`
- 测试：`tests/integrations/test_codex_speed.py`、`tests/desktop/test_service.py`、`ui/tests/harness-switch.smoke.mjs`
- [Codex app-server 速度档位说明](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#model-provider-admission) · [Ultrafast 文档](https://developers.openai.com/api/docs/guides/ultrafast-mode)
