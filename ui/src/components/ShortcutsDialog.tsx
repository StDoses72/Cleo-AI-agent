import { t as tr } from "../../electron/i18n.mjs";
import { X } from "lucide-react";
import { Modal } from "./Modal";

/** Purpose: One sheet listing every keyboard shortcut, grouped by where it applies (Ctrl+/). */
export function ShortcutsDialog({ open, modifierKey, onClose }: { open: boolean; modifierKey: string; onClose: () => void }) {
  const groups: { title: string; rows: [string, string][] }[] = [
    { title: tr("shortcuts.group_app"), rows: [
      [`${modifierKey} K`, tr("shortcuts.palette")],
      [`${modifierKey} N`, tr("app.new_task")],
      [`${modifierKey} Shift N`, tr("app.new_chat")],
      [`${modifierKey} Tab`, tr("app.next_conversation")],
      [`${modifierKey} Shift Tab`, tr("shortcuts.previous_conversation")],
      [`${modifierKey} B`, tr("app.toggle_sidebar_hint")],
      [`${modifierKey} Shift D`, tr("shortcuts.details_panel")],
      [`${modifierKey} ,`, tr("app.open_settings")],
      [`${modifierKey} /`, tr("shortcuts.this_sheet")],
    ] },
    { title: tr("shortcuts.group_composer"), rows: [
      ["Enter", tr("shortcuts.send_or_queue")],
      [`${modifierKey} Enter`, tr("shortcuts.steer_now")],
      ["Shift Enter", tr("shortcuts.new_line")],
      ["/", tr("shortcuts.commands")],
      ["@", tr("shortcuts.mention_file")],
      [`${modifierKey} L`, tr("app.focus_composer")],
      [`${modifierKey} Shift M`, tr("shortcuts.model_menu")],
      [`${modifierKey} Shift A`, tr("shortcuts.access_menu")],
      ["Esc", tr("shortcuts.stop_run")],
    ] },
    { title: tr("shortcuts.group_review"), rows: [
      ["↑ ↓", tr("shortcuts.move_line_cursor")],
      ["Enter / C", tr("shortcuts.comment_on_line")],
      [`${modifierKey} Enter`, tr("shortcuts.save_comment")],
      ["← → Home End", tr("shortcuts.switch_details_tab")],
    ] },
  ];
  return (
    <Modal open={open} onClose={onClose} className="overlay-backdrop shortcuts-backdrop" label={tr("shortcuts.title")}>
      <div className="shortcuts-dialog">
        <header>
          <strong>{tr("shortcuts.title")}</strong>
          <button type="button" className="icon-button" aria-label={tr("app.close")} title={tr("app.close")} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="shortcuts-groups" data-testid="shortcuts-sheet">
          {groups.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.rows.map(([keys, label]) => (
                  <div key={keys}><dt>{label}</dt><dd>{keys.split(" ").map((key) => <kbd key={key}>{key}</kbd>)}</dd></div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
