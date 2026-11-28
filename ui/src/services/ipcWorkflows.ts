import type { ProductivityModelCatalog, RuntimeModelOption } from "../types";
import type { WorkflowClient, WorkflowDefinition, WorkflowHarness, WorkflowLibrary, WorkflowNodeFields, WorkflowPermission, WorkflowRole } from "../workflow-types";

type Request = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** What the backend says of a harness: what a node on it can be held to. Its models are read apart. */
interface HarnessView {
  id: string;
  readOnly: boolean;
  tools: boolean;
  permissions: WorkflowPermission[];
}

/** How long a harness's model list is reused: reading one starts the harness. */
const MODELS_FRESH_MS = 5 * 60_000;

/** Purpose: The workflow library over the desktop protocol. A workflow is run by sending
 * `/workflow` in a conversation, so nothing here starts one. */
export class IpcWorkflowClient implements WorkflowClient {
  private readonly models = new Map<string, { at: number; read: Promise<{ models: RuntimeModelOption[]; reason: string | null }> }>();

  constructor(private readonly request: Request) {}

  /** A harness's models, or why they could not be read (signed out, not installed). */
  private modelsOf(harness: string) {
    const known = this.models.get(harness);
    if (known && Date.now() - known.at < MODELS_FRESH_MS) return known.read;
    const read = this.request<ProductivityModelCatalog>("get_productivity_models", { provider: harness })
      .then((catalog) => ({ models: catalog.models, reason: null }),
        (error: unknown) => {
          // A failed read is tried again the next time it is needed.
          this.models.delete(harness);
          return { models: [], reason: error instanceof Error ? error.message : String(error) };
        });
    this.models.set(harness, { at: Date.now(), read });
    return read;
  }

  /** With `models`, every harness's models are read first: the canvas needs them to offer and to
   * check a node's choices. Without, the answer is immediate and holds only models already read. */
  async library(options: { models?: boolean } = {}): Promise<WorkflowLibrary> {
    const view = await this.request<{ workflows: WorkflowDefinition[]; roles: WorkflowRole[]; harnesses: HarnessView[] }>("get_workflow_library");
    const harnesses = await Promise.all(view.harnesses.map(async (harness): Promise<WorkflowHarness> => {
      const known = options.models ? await this.modelsOf(harness.id) : await Promise.race([
        this.models.get(harness.id)?.read ?? Promise.resolve(null), Promise.resolve(null)]);
      return { ...harness, label: harness.id, models: known?.models ?? [],
        available: !known?.reason, reason: known?.reason ?? null };
    }));
    return { workflows: view.workflows, roles: view.roles, harnesses };
  }

  save(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    return this.request("save_workflow", { definition });
  }

  async remove(workflowId: string): Promise<void> {
    await this.request("remove_workflow", { workflow_id: workflowId });
  }

  draftNode(intent: string, definition: WorkflowDefinition, nodeId: string): Promise<Partial<WorkflowNodeFields>> {
    return this.request("draft_workflow_node", { intent, definition, node_id: nodeId });
  }

  saveRole(fields: WorkflowNodeFields): Promise<WorkflowRole> {
    return this.request("save_workflow_role", { fields });
  }

  async removeRole(roleId: string): Promise<void> {
    await this.request("remove_workflow_role", { role_id: roleId });
  }
}
