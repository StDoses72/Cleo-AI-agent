import { t as tr } from "../../../electron/i18n.mjs";
import { useState } from "react";
import { Check, KeyRound, Search, UserRound } from "lucide-react";
import type { ModelProfileSummary } from "../../types";
import { billingLabel, isAccount, modelLabel, profileLabel, profileModels } from "./catalog";
import { ModelDialog } from "./ModelDialog";

export interface ModelChoice { profileId: string; model: string }

export function ModelPicker({ title, profiles, selected, busy, error, onSelect, onClose }: {
  title: string; profiles: ModelProfileSummary[]; selected: ModelChoice | null;
  busy: boolean; error?: string; onSelect: (choice: ModelChoice) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const groups = profiles.map(profile => ({ profile, models: profileModels(profile).filter(model =>
    `${model} ${modelLabel(model)} ${profileLabel(profile)}`.toLowerCase().includes(query.trim().toLowerCase())) })).filter(group => group.models.length);
  return <ModelDialog title={title} onClose={() => { if (!busy) onClose(); }}>
    <div className="ms-search"><Search /><input autoFocus aria-label={tr("modelpicker.search_models")} placeholder={tr("modelpicker.search_models_or_connections")} value={query} onChange={e => setQuery(e.target.value)} /></div>
    <div className="ms-picker-scroll" role="radiogroup" aria-label={tr("connectiondetails.configured_models")}>
      {groups.map(({ profile, models }) => <section key={profile.name}>
        <div className="ms-picker-group">{isAccount(profile) ? <UserRound /> : <KeyRound />}{profileLabel(profile)}<span>· {billingLabel(profile)}</span></div>
        {models.map(model => {
          const active = selected?.profileId === profile.name && selected.model === model;
          return <button key={model} className={`ms-picker-row ${active ? "selected" : ""}`} role="radio" aria-checked={active} disabled={busy} onClick={() => onSelect({ profileId: profile.name, model })}>
            <span><strong title={model}>{modelLabel(model)}</strong></span>{active && <Check />}
          </button>;
        })}
      </section>)}
      {!groups.length && <div className="ms-empty"><strong>{tr("modelpicker.no_matching_models")}</strong><button className="ms-link" onClick={() => setQuery("")}>{tr("modelpicker.clear_search")}</button></div>}
    </div>
    {error && <p className="ms-error" role="alert">{error}</p>}
    {busy && <footer className="ms-dialog-footer" role="status">{tr("modelpicker.switching")}</footer>}
  </ModelDialog>;
}
