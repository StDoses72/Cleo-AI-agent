import { useEffect, useRef, useState } from "react";
import { requestKey } from "./request-key";
import { cleoClient } from "./services/cleoClient";
import type { QuestionRequest, Thread } from "./types";

export type QuestionDraft = Record<string, { selected: string[]; text: string }>;

export function useQuestions(thread: Thread | null, update: (id: string, fn: (t: Thread) => Thread) => void) {
  const [requests, setRequests] = useState<QuestionRequest[]>([]);
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string[]>([]);
  const sending = useRef(new Set<string>());
  const revision = useRef(new Map<string, number>());
  const bump = (id: string) => revision.current.set(id, (revision.current.get(id) ?? 0) + 1);
  const owners = useRef(new Map<string, string>());
  const restore = (threadId: string, pending: QuestionRequest[], expected: number | undefined) => {
    if (revision.current.get(threadId) !== expected) return;
    for (const request of pending) owners.current.set(requestKey(threadId, request.id), threadId);
    setRequests(current => [...current.filter(request => request.threadId !== threadId), ...pending]);
  };

  useEffect(() => {
    if (!thread) return;
    let active = true;
    const version = revision.current.get(thread.id);
    void cleoClient.getPendingQuestions(thread.id).then(pending => {
      if (!active || version !== revision.current.get(thread.id)) return;
      for (const request of pending) owners.current.set(requestKey(request.threadId, request.id), request.threadId);
      setRequests(current => [...current.filter(q => q.threadId !== thread.id), ...pending]);
    }).catch(() => {
      if (active && version === revision.current.get(thread.id)) setRequests(current => current.map(q => q.threadId === thread.id ? { ...q, status: "unavailable" } : q));
    });
    return () => { active = false; };
  }, [thread?.id]);

  const receive = (request: QuestionRequest, turnId?: string, showInTimeline = true) => {
    bump(request.threadId);
    owners.current.set(requestKey(request.threadId, request.id), request.threadId);
    setRequests(current => [...current.filter(q => q.threadId !== request.threadId || q.id !== request.id), request]);
    if (showInTimeline) update(request.threadId, current => ({ ...current, items: [...current.items.filter(i => i.id !== request.id), { id: request.id, type: "question", request, turnId, cursor: request.cursor, order: request.order }] }));
  };
  const resolve = (threadId: string, value: Pick<QuestionRequest, "id" | "status" | "answers">) => {
    bump(threadId);
    setRequests(current => current.filter(q => q.threadId !== threadId || q.id !== value.id));
    update(threadId, current => ({ ...current, items: current.items.map(item => item.type === "question" && item.id === value.id ? { ...item, request: { ...item.request, ...value } } : item) }));
    setDrafts(current => { const next = { ...current }; delete next[requestKey(threadId, value.id)]; return next; });
    setCollapsed(current => { const next = { ...current }; delete next[requestKey(threadId, value.id)]; return next; });
    setErrors(current => { const next = { ...current }; delete next[requestKey(threadId, value.id)]; return next; });
    owners.current.delete(requestKey(threadId, value.id));
  };
  const finish = (threadId: string) => {
    bump(threadId);
    setRequests(current => current.filter(q => q.threadId !== threadId));
    update(threadId, current => ({ ...current, items: current.items.map(item => item.type === "question" && item.request.status === "pending" ? { ...item, request: { ...item.request, status: "unavailable" } } : item) }));
    const ids = [...owners.current].filter(([, owner]) => owner === threadId).map(([id]) => id);
    setDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))));
    setCollapsed(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))));
    setErrors(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))));
    for (const id of ids) owners.current.delete(id);
  };
  const current = requests.find(q => q.threadId === thread?.id && q.status === "pending") ?? null;
  const submit = async () => {
    const request = current;
    if (!request) return;
    const key = requestKey(request.threadId, request.id);
    if (sending.current.has(key)) return;
    const draft = drafts[key] ?? {};
    const answers = Object.fromEntries(request.questions.map(q => {
      const value = draft[q.id] ?? { selected: [], text: "" };
      const text = value.text.trim();
      return [q.id, q.multiple ? [...value.selected, ...(text ? [text] : [])] : text ? [text] : value.selected];
    }));
    if (Object.values(answers).some(values => !values.length)) {
      setErrors(errors => ({ ...errors, [key]: "请回答每一个问题，再提交。" })); return;
    }
    sending.current.add(key); setBusy(current => [...current, key]);
    setErrors(errors => ({ ...errors, [key]: "" }));
    try {
      await cleoClient.resolveQuestion(request.threadId, request.id, answers);
      resolve(request.threadId, { id: request.id, status: "answered", answers });
    } catch (failure) {
      setErrors(errors => ({ ...errors, [key]: failure instanceof Error ? failure.message : "提交失败，可以重试" }));
    } finally { sending.current.delete(key); setBusy(current => current.filter(value => value !== key)); }
  };
  const key = current ? requestKey(current.threadId, current.id) : "";
  return { current, pending: requests.filter(q => q.status === "pending"), receive, resolve, finish, submit, restore,
    version: (threadId: string) => revision.current.get(threadId),
    open: Boolean(current && !collapsed[key]), busy: busy.includes(key),
    error: current ? errors[key] : undefined,
    draft: current ? drafts[key] ?? {} : {},
    setDraft: (draft: QuestionDraft) => { if (current) setDrafts(d => ({ ...d, [key]: draft })); },
    collapse: () => { if (current) setCollapsed(c => ({ ...c, [key]: true })); },
    reopen: () => { if (current) setCollapsed(c => ({ ...c, [key]: false })); },
  };
}
