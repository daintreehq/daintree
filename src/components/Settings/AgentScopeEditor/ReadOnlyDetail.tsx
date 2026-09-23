import { Button } from "@/components/ui/button";
import { SettingsRow } from "../SettingsGroup";
import { stripCcrPrefix } from "./scopeUtils";
import type { AgentPreset } from "@/config/agents";

interface ReadOnlyDetailProps {
  scopeKind: "ccr" | "project";
  selectedPreset: AgentPreset;
  onDuplicate: (preset: AgentPreset) => void;
}

const MODE_LABEL = { inherit: "Default", on: "On", off: "Off" } as const;

/**
 * A project or CCR preset, shown as read-only rows in the same group as the preset
 * picker. The way to change one is to duplicate it, so that is the first row's action
 * rather than an unlabelled glyph.
 */
export function ReadOnlyDetail({ scopeKind, selectedPreset, onDuplicate }: ReadOnlyDetailProps) {
  const displayName =
    scopeKind === "ccr" ? stripCcrPrefix(selectedPreset.name) : selectedPreset.name;
  const env = Object.entries(selectedPreset.env ?? {});
  const source =
    scopeKind === "project"
      ? "Read-only — it lives in this project's .daintree/presets folder, so edits belong in the repository"
      : "Read-only — it comes from your Claude Code Router config";

  return (
    <>
      <SettingsRow
        label="Make an editable copy"
        description={source}
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDuplicate(selectedPreset)}
            aria-label={`Duplicate ${displayName}`}
          >
            Duplicate as custom
          </Button>
        }
      />
      {scopeKind === "project" && selectedPreset.description && (
        <SettingsRow
          label="Description"
          layout="stacked"
          control={
            <p className="text-xs text-text-secondary select-text">{selectedPreset.description}</p>
          }
        />
      )}
      {env.length > 0 && (
        <SettingsRow
          label="Environment variables"
          layout="stacked"
          control={
            <dl className="grid gap-1 font-mono text-xs select-text">
              {env.map(([k, v]) => (
                <div key={k} className="flex min-w-0 gap-2">
                  <dt className="shrink-0 text-text-primary">{k}</dt>
                  <dd className="min-w-0 truncate text-text-secondary">{v}</dd>
                </div>
              ))}
            </dl>
          }
        />
      )}
      {selectedPreset.customFlags && (
        <SettingsRow
          label="Custom arguments"
          layout="stacked"
          control={
            <code className="font-mono text-xs text-text-secondary select-text">
              {selectedPreset.customFlags}
            </code>
          }
        />
      )}
      {selectedPreset.dangerousMode && selectedPreset.dangerousMode !== "inherit" && (
        <SettingsRow
          label="Skip permissions"
          control={
            <span className="text-sm text-text-secondary">
              {MODE_LABEL[selectedPreset.dangerousMode]}
            </span>
          }
        />
      )}
    </>
  );
}
