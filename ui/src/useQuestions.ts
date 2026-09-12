import { useEffect, useRef, useState } from "react";
import { cleoClient } from "./services/cleoClient";
import type { QuestionRequest, Thread } from "./types";

export type QuestionDraft = Record<string, { selected: string[]; text: string }>;

export function useQuestions(thread: Thread | null, update: (id: string, fn: (t: Thread) => Thread) => void) {
  const [requests, setRequests] = useState<QuestionRequest[]>([]);
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const sending = useRef(new Set<string>());
  const revision = useRef(0);
  const owners = useRef(new Map<string, string>());

  useEffect(() => {
    if (!thread) return;
    let active = true;
    const version = revision.current;
    void cleoClient.getPendingQuestions(thread.id).then(pending => {
      if (!active || version !== revision.current) return;
      for (const request of pending) owners.current.set(request.id, request.threadId);
      setRequests(current => [...current.filter(q => q.threadId !== thread.id), ...pending]);
    }).catch(() => {
      if (active && version === revision.current) setRequests(current => current.map(q => q.threadId === thread.id ? { ...q, status: "unavailable" } : q));
    });
    return () => { active = false; };
  }, [thread?.id]);

  const receive = (request: QuestionRequest, turnId?: string, showInTimeline = true) => {
    revision.current++;
    owners.current.set(request.id, request.threadId);
    setRequests(current => [...current.filter(q => q.id !== request.id), request]);
    if (showInTimeline) update(request.threadId, current => ({ ...current, items: [...current.items.filter(i => i.id !== request.id), { id: request.id, type: "question", request, turnId, cursor: request.cursor, order: request.order }] }));
  };
  const resolve = (threadId: string, value: Pick<QuestionRequest, "id" | "status" | "answers">) => {
    revision.current++;
    setRequests(current => current.filter(q => q.id !== value.id));
    update(threadId, current => ({ ...current, items: current.items.map(item => item.type === "question" && item.id === value.id ? { ...item, request: { ...item.request, ...value } } : item) }));
    setDrafts(current => { const next = { ...current }; delete next[value.id]; return next; });
    setCollapsed(current => { const next = { ...current }; delete next[value.id]; return next; });
    setErrors(current => { const next = { ...current }; delete next[value.id]; return next; });
    owners.current.delete(value.id);
  };
  const finish = (threadId: string) => {
    revision.current++;
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
    if (!request || sending.current.has(request.id)) return;
    const draft = drafts[request.id] ?? {};
    const answers = Object.fromEntries(request.questions.map(q => {
      const value = draft[q.id] ?? { selected: [], text: "" };
      const text = value.text.trim();
      return [q.id, q.multiple ? [...value.selected, ...(text ? [text] : [])] : text ? [text] : value.selected];
    }));
    if (Object.values(answers).some(values => !values.length)) {
      setErrors(errors => ({ ...errors, [request.id]: "请回答每一个问题，再提交。" })); return;
    }
    sending.current.add(request.id); setBusy(request.id);
    setErrors(errors => ({ ...errors, [request.id]: "" }));
    try {
      await cleoClient.resolveQuestion(request.threadId, request.id, answers);
      resolve(request.threadId, { id: request.id, status: "answered", answers });
    } catch (failure) {
      setErrors(errors => ({ ...errors, [request.id]: failure instanceof Error ? failure.message : "提交失败，可以重试" }));
    } finally { sending.current.delete(request.id); setBusy(null); }
  };
  return { current, receive, resolve, finish, submit,
    open: Boolean(current && !collapsed[current.id]), busy: busy === current?.id,
    error: current ? errors[current.id] : undefined,
    draft: current ? drafts[current.id] ?? {} : {},
    setDraft: (draft: QuestionDraft) => { if (current) setDrafts(d => ({ ...d, [current.id]: draft })); },
    collapse: () => { if (current) setCollapsed(c => ({ ...c, [current.id]: true })); },
    reopen: () => { if (current) setCollapsed(c => ({ ...c, [current.id]: false })); },
  };
}
