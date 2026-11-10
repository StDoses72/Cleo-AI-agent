import { t as tr } from "./i18n.mjs";
/** Purpose: Keep switching code independent of windows and never restore user data.
 * Input: store and launch/health/termination/progress hooks.
 * Output: success only after a selected or fallback program acknowledges startup; failure leaves recovery to the caller.
 */
export async function runHandoff(store, hooks) {
  const initial = await store.read();
  if (!initial.transaction) return { ok: false, error: tr("evolution_handoff.there_is_no_pending_version_switch") };
  const targets = [...new Set([initial.transaction.to, initial.transaction.from, initial.baseline].filter(Boolean))];
  let detail = "";
  for (let index = 0; index < targets.length; index += 1) {
    let child;
    try {
      const build = await hooks.withLock(async () => {
        if (index) {
          await store.recover(targets[index]);
          await store.stage(targets[index], { restartError: tr("evolution_handoff.the_previous_application_did_not_start_successfully_cleo_returned_to_a_working_versio") });
        }
        return store.activate();
      });
      const transaction = (await store.read()).transaction;
      await hooks.progress(index ? tr("evolution_handoff.restoring_a_working_version") : tr("evolution_handoff.starting_the_modified_cleo"),
        index ? tr("evolution_handoff.the_new_version_could_not_start_rolling_back_automatically_your_data_is_unchanged") : tr("evolution_handoff.this_window_closes_automatically_once_the_main_interface_and_backend_are_ready"));
      child = await hooks.launch(build, transaction.id);
      if (await hooks.waitHealthy(child, transaction.id, build.id)) {
        return { ok: true, recovered: index > 0, active: build.id };
      }
      throw new Error(tr("evolution_handoff.the_program_did_not_complete_startup_checks_within_the_allotted_time"));
    } catch (error) {
      detail = error.message;
      if (child) {
        try { await hooks.stop(child); }
        catch { return { ok: false, error: tr("evolution_handoff.the_new_program_has_not_fully_exited_recovery_will_stay_open_close_that_program_and_r") }; }
      }
    }
  }
  return { ok: false, error: detail || tr("evolution_handoff.no_version_started_successfully_choose_another_available_version") };
}
