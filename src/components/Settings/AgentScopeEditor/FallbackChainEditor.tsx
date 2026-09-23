import { useMemo } from "react";
import { X as XIcon } from "lucide-react";
import { FALLBACK_CHAIN_MAX } from "../../../../shared/config/agentRegistry";
import type { AgentPreset } from "@/config/agents";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SETTINGS_CONTROL_WIDTH, SettingsDependents, SettingsRow } from "../SettingsGroup";

interface FallbackChainEditorProps {
  selectedPreset: AgentPreset;
  allPresets: AgentPreset[];
  onUpdatePreset: (presetId: string, patch: Partial<AgentPreset>) => void;
}

export function FallbackChainEditor({
  selectedPreset,
  allPresets,
  onUpdatePreset,
}: FallbackChainEditorProps) {
  const chain = selectedPreset.fallbacks ?? [];

  const candidates = useMemo(
    () => allPresets.filter((p) => p.id !== selectedPreset.id && !chain.includes(p.id)),
    [allPresets, selectedPreset.id, chain]
  );

  const removeFallback = (id: string) => {
    onUpdatePreset(selectedPreset.id, {
      fallbacks: chain.filter((f) => f !== id),
    });
  };

  const addFallback = (id: string) => {
    if (!id || chain.includes(id) || chain.length >= FALLBACK_CHAIN_MAX) return;
    onUpdatePreset(selectedPreset.id, {
      fallbacks: [...chain, id],
    });
  };

  const canAdd = chain.length < FALLBACK_CHAIN_MAX && candidates.length > 0;
  const addStatus =
    chain.length >= FALLBACK_CHAIN_MAX
      ? `Maximum of ${FALLBACK_CHAIN_MAX} fallbacks reached`
      : candidates.length === 0
        ? "No other presets available for this agent"
        : null;

  return (
    <>
      <SettingsRow
        label="Fallback presets"
        description="Tried in order if this preset's provider is unreachable. No retry for rate limits or prompt errors"
        control={({ descriptionId, disabled }) =>
          canAdd ? (
            <select
              className={cn(
                "rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas px-3 py-1.5 text-sm text-text-primary",
                "focus:outline-hidden focus:border-accent-primary disabled:opacity-50",
                SETTINGS_CONTROL_WIDTH.select
              )}
              value=""
              disabled={disabled}
              onChange={(e) => {
                const v = e.target.value;
                if (v) addFallback(v);
              }}
              aria-label="Add fallback preset"
              aria-describedby={descriptionId}
            >
              <option value="">Add fallback preset…</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-text-secondary">{addStatus}</span>
          )
        }
      />
      {chain.length > 0 && (
        <SettingsDependents>
          {chain.map((id, idx) => {
            const preset = allPresets.find((p) => p.id === id);
            const name = preset?.name ?? id;
            const missing = !preset;
            return (
              <SettingsRow
                key={id}
                labelText={name}
                label={
                  <span className={cn("flex items-baseline gap-2", missing && "text-status-error")}>
                    <span className="text-xs text-text-secondary font-mono tabular-nums">
                      {idx + 1}.
                    </span>
                    <span className="truncate">
                      {name}
                      {missing && " (missing)"}
                    </span>
                  </span>
                }
                className="py-2"
                control={({ disabled }) => (
                  <Button
                    variant="ghost-danger"
                    size="icon-sm"
                    disabled={disabled}
                    onClick={() => removeFallback(id)}
                    aria-label={`Remove ${name} from fallback chain`}
                    title="Remove"
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                )}
              />
            );
          })}
        </SettingsDependents>
      )}
    </>
  );
}
