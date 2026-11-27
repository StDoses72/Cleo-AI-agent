import { t as tr } from "../../../electron/i18n.mjs";
import { Check } from "lucide-react";
import { useState } from "react";
import type { WorkflowDefinition } from "../../workflow-types";
import { WorkflowThumb } from "./WorkflowView";
import "./workflows.css";

/** Purpose: A workflow an agent wrote for the user, where it was handed back in the conversation:
 * its shape, its name, and the one decision to make about it. The shape opens it on the canvas. */
export function WorkflowProposalCard({ definition, added, onAdd, onOpen }: {
  definition: WorkflowDefinition;
  /** The library already holds it. */
  added: boolean;
  onAdd?: () => Promise<void>;
  onOpen?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="wf-proposal" data-testid="workflow-proposal" data-added={added || undefined} aria-label={definition.name}>
      <button type="button" className="wf-proposal-open" data-testid="workflow-proposal-open" onClick={onOpen}
        aria-label={`${tr("workflows.edit")} ${definition.name}`} title={tr("workflows.edit")}>
        <WorkflowThumb definition={definition} />
      </button>
      <div className="wf-proposal-copy">
        <strong title={definition.name}>{definition.name}</strong>
        <small>{tr("workflows.node_count", { p0: definition.nodes.length })}</small>
      </div>
      {added ? <span className="wf-state-note saved" data-testid="workflow-proposal-added"><Check size={13} />{tr("workflows.added")}</span> : (
        <button type="button" className="wf-button primary" data-testid="workflow-proposal-add" disabled={adding || !onAdd}
          onClick={() => { setAdding(true); void onAdd?.().finally(() => setAdding(false)); }}>{tr("workflows.add_to_library")}</button>
      )}
    </section>
  );
}
