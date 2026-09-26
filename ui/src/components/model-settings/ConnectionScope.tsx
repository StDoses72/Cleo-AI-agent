import { accountCheckScope } from "./catalog";

export function ConnectionScope({ note }: { note?: string }) {
  return <details className="ms-check-scope"><summary>{note ? "用量与检查范围" : "检查范围"}</summary>
    {note && <p>{note}</p>}<p>{accountCheckScope}</p>
  </details>;
}
