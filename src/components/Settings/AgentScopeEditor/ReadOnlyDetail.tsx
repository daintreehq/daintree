import { Button } from "@/components/ui/button";
import { SETTINGS_CONTROL_WIDTH, SettingsRow } from "../SettingsGroup";
import { stripCcrPrefix } from "./scopeUtils";
import type { AgentPreset } from "@/config/agents";
import { resolveDangerousMode, resolveInlineMode } from "@shared/types";

interface ReadOnlyDetailProps {
  scopeKind: "ccr" | "project";
  selectedPreset: AgentPreset;
  agentName: string;
  /** The agent's own arguments, used when the preset sets none. */
  agentCustomFlags: string;
  /** Resolved the way a launch resolves them, preset over agent over global. */
  effectiveSkipPerms: boolean;
  /** Undefined for agents without a screen-mode choice. */
  effectiveInline: boolean | undefined;
  onDuplicate: (preset: AgentPreset) => void;
}

/**
 * A project or CCR preset, as read-only rows under the preset picker. Each launch
 * setting shows the value a launch would actually get and where it comes from, so a
 * preset that sets nothing still answers "what will this do". The way to change one is
 * to duplicate it, so that is the first row's action.
 */
export function ReadOnlyDetail({
  scopeKind,
  selectedPreset,
  agentName,
  agentCustomFlags,
  effectiveSkipPerms,
  effectiveInline,
  onDuplicate,
}: ReadOnlyDetailProps) {
  const displayName =
    scopeKind === "ccr" ? stripCcrPrefix(selectedPreset.name) : selectedPreset.name;
  const env = Object.entries(selectedPreset.env ?? {});
  const source =
    scopeKind === "project"
      ? "It lives in this project's .daintree/presets folder, so edits belong in the repository"
      : "It comes from your Claude Code Router config";
  const fromPreset = "Set by this preset";
  const fromAgent = `Follows ${agentName}'s own setting`;

  const presetSetsArgs = selectedPreset.customFlags !== undefined;
  const args = presetSetsArgs ? selectedPreset.customFlags : agentCustomFlags;
  const presetSetsSkip = resolveDangerousMode(selectedPreset) !== "inherit";
  const presetSetsInline = resolveInlineMode(selectedPreset) !== "inherit";

  const value = (text: string, mono = false) => (
    <span
      className={
        mono
          ? `${SETTINGS_CONTROL_WIDTH.wide} truncate text-right font-mono text-xs text-text-primary select-text`
          : "text-sm text-text-primary"
      }
    >
      {text}
    </span>
  );

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
        <SettingsRow label="Description" description={selectedPreset.description} />
      )}
      {env.length > 0 && (
        <SettingsRow
          label="Environment variables"
          description={`Added to ${agentName}'s own variables, replacing any with the same name`}
          layout="stacked"
          control={
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs select-text">
              {env.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-text-primary">{k}</dt>
                  <dd className="truncate text-text-secondary">{v}</dd>
                </div>
              ))}
            </dl>
          }
        />
      )}
      <SettingsRow
        label="Custom arguments"
        description={presetSetsArgs ? fromPreset : fromAgent}
        control={value(args ? args : "None", !!args)}
      />
      <SettingsRow
        label="Skip permissions"
        description={presetSetsSkip ? fromPreset : fromAgent}
        control={value(effectiveSkipPerms ? "On" : "Off")}
      />
      {effectiveInline !== undefined && (
        <SettingsRow
          label="Alt-screen mode"
          description={presetSetsInline ? fromPreset : fromAgent}
          control={value(effectiveInline ? "Inline" : "Alt screen")}
        />
      )}
    </>
  );
}
