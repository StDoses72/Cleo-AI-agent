import { t as tr } from "./i18n.mjs";
import { ProgramStore } from "./program-store.mjs";

/** Purpose: Add local-iteration bookkeeping to the shared program registry. */
export class EvolutionStore extends ProgramStore {
  /** Purpose: Mark the start of editable work without losing the selected starting version.
   * Input: none. Output: persisted iteration base, retained across repeated apply/restart cycles.
   */
  async beginIteration() {
    const state = await this.read();
    if (state.iteration) {
      await this.update({ draftDirty: true });
      return state.iteration;
    }
    await this.build(state.active);
    const iteration = { base: state.active, startedAt: new Date().toISOString() };
    await this.update({ iteration, draftDirty: true, workspaceBase: state.workspaceBase || state.selectedBase || state.active });
    return iteration;
  }

  /** Purpose: Keep the currently applied program as a selectable local version.
   * Input: optional display name. Output: saved build; no release is created and no data is rewritten.
   */
  async saveVersion(name = "") {
    const state = await this.read();
    if (state.transaction) throw new Error(tr("evolution_store.wait_for_application_startup_to_finish_before_saving"));
    const build = await this.build(state.active);
    if (!state.iteration || build.kind !== "local" || build.id === state.iteration.base) {
      throw new Error(tr("evolution_store.apply_this_iteration_s_changes_before_saving_a_local_version"));
    }
    const saveSequence = (state.saveSequence || state.builds.filter((item) => item.savedAt).length) + 1;
    const saved = { ...state.builds.find((item) => item.id === build.id),
      name: String(name).trim().slice(0, 80) || undefined,
      savedAt: new Date().toISOString() };
    await this.update({ builds: state.builds.map((item) => item.id === saved.id ? saved : item),
      iteration: null, candidate: null, draftDirty: false, selectedBase: saved.id, latestSaved: saved.id, saveSequence,
      workspaceBase: state.workspaceBase || state.iteration.base, baseSourceHash: saved.sourceHash });
    await this.pruneBuilds();
    return saved;
  }
}
