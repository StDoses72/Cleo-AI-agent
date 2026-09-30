export function requestKey(threadId: string, requestId: string) {
  return JSON.stringify([threadId, requestId]);
}
