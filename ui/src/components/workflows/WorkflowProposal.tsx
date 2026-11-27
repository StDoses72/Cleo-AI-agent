import { t as tr } from "../../../electron/i18n.mjs";
import { Check } from "lucide-react";
import type { WorkflowDefinition } from "../../workflow-types";
import { WorkflowThumb } from "./WorkflowView";
import "./workflows.css";

/** Purpose: A workflow an agent wrote for the user, where it was handed back in the conversation:
 * its shape and its name. Opening it shows it built on the canvas, where the user keeps it or not. */
export function WorkflowProposalCard({ definition, saved, onOpen }: {
  definition: WorkflowDefinition;
  /** The library already holds it. */
  saved: boolean;
  onOpen?: () => void;
}) {
  return (
    <section className="wf-proposal" data-testid="workflow-proposal" aria-label={definition.name}>
      <div className="wf-proposal-thumb"><WorkflowThumb definition={definition} /></div>
      <div className="wf-proposal-copy">
        <strong title={definition.name}>{definition.name}</strong>
        <small>{tr("workflows.node_count", { p0: definition.nodes.length })}</small>
      </div>
      {saved ? <span className="wf-state-note saved" data-testid="workflow-proposal-saved"><Check size={13} />{tr("workflows.saved")}</span> : null}
      <button type="button" className={`wf-button ${saved ? "" : "primary"}`} data-testid="workflow-proposal-open" disabled={!onOpen} onClick={onOpen}>
        {tr("workflows.proposal_open")}
      </button>
    </section>
  );
}
