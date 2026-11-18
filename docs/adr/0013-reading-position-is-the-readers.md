# 0013. 流式回复期间阅读位置归读者；「视口跟随」与「接收本轮输出」分开

- **Status**: Accepted
- **Date**: 2026-11-17

## Context

发送消息后，会话视口一直贴着回复末尾下移，想从回复开头读起就得往上翻（#176）。

改动前，`useTimelineHistory` 里的一个标志同时承担两件事：视口是否贴底，以及已加载的历史窗口是否到达最新。`useCleoWorkspace.upsertTimelineItem` 只在这个标志为真时追加实时条目，否则把 `history.hasAfter` 置真并显示「回到最新」。结果是读者只要往上滚 1 像素，本轮的新输出就不再进入时间线。

## Decision

**两个状态分开。**

- 「接收本轮输出」只取决于已加载窗口是否到达最新：`useTimelineHistory.isFollowing` 改为 `!history.hasAfter`。读者停在任何位置，实时条目都继续追加。只有翻页离开最新一页（`hasAfter` 为真）时才停止追加。
- 「视口跟随」是 `followRef` / `isPinned`，只由读者的滚动改变。

**发送时定位一次，之后不动。**

- 发送后视口取消贴底。提问下方的可见空间不少于 `REPLY_ROOM`（160 像素）时不移动。
- 空间不足时，把提问移到距视口顶部 `QUESTION_TOP`（20 像素）处；提问本身太高时，改为让它的底部留出 `REPLY_ROOM`。时间线末尾的 `.turn-space` 占位把这一轮补足到一屏，随回复增长收缩到零。
- 读者自己滚到底部（或在底部继续向下滚动）后视口才跟随末尾，向上滚动即停止。
- 运行结束时的后台刷新（`history.load("latest", …, keepPosition)`）不再把视口拉回底部。
- 「回到最新」在窗口未到最新、或视口未贴底且下方还有内容时显示。

打开一个会话仍然贴底显示，运行中的会话照旧跟随；本决策只改变发送之后的行为。

## Alternatives considered

- **保持贴底跟随，另加一个「暂停跟随」开关。** 增加一个控件，默认行为仍然是读者要追着末尾读。
- **始终把提问放到视口顶部并补一屏占位。** 提问下方本来有空间时也会移动，短会话里会凭空出现滚动条和大片空白；issue 的验收标准要求这种情况保持原位。
- **只取消贴底，不移动提问。** 提问贴近底部时回复开头落在视口之外，读者仍然要自己滚动。

## Consequences

- 发送后不滚动的读者不会自动看到回复末尾，需要自己向下滚或点「回到最新」。
- 向上回看时本轮输出继续追加到时间线，窗口里的条目数只受 `boundTimeline` 的上限约束，和贴底时相同。
- `.turn-space` 的高度在 `Conversation` 重新渲染时重算。行高在两次渲染之间变化（例如图片晚加载）时，占位会晚一拍更新。
- 没有为发送时的定位写自动化用例，只在 mock UI 里实测过两种情况（下方有空间、贴近底部）；`smoke:history`、`smoke:steering`、`smoke:layout` 覆盖滚动与跟随的原有行为。

## References

- Issue #176。
- `ui/src/components/Conversation.tsx`：`REPLY_ROOM`、`QUESTION_TOP`、`measureTail`、`trackScrollPosition`。
- `ui/src/useTimelineHistory.ts`：`isFollowing`、`isPinned`、`load` 的 `keepPosition`。
- `ui/src/useCleoWorkspace.ts`：`upsertTimelineItem`。
