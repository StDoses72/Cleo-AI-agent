import { t as tr } from "../../../electron/i18n.mjs";
import { accountCheckScope } from "./catalog";

export function ConnectionScope({ note }: { note?: string }) {
  return <details className="ms-check-scope"><summary>{note ? tr("connectionscope.usage_and_verification_scope") : tr("connectionscope.verification_scope")}</summary>
    {note && <p>{note}</p>}<p>{accountCheckScope()}</p>
  </details>;
}
