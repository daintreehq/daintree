import { useMemo, useCallback } from "react";
import { X as XIcon } from "lucide-react";
import { FALLBACK_CHAIN_MAX } from "../../../../shared/config/agentRegistry";
import type { AgentPreset } from "@/config/agents";

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

  const removeFallback = useCallback(
    (id: string) => {
      onUpdatePreset(selectedPreset.id, {
        fallbacks: chain.filter((f) => f !== id),
      });
    },
    [selectedPreset.id, chain, onUpdatePreset]
  );

  const addFallback = useCallback(
    (id: string) => {
      if (!id || chain.includes(id) || chain.length >= FALLBACK_CHAIN_MAX) return;
      onUpdatePreset(selectedPreset.id, {
        fallbacks: [...chain, id],
      });
    },
    [selectedPreset.id, chain, onUpdatePreset]
  );

  return (
    <div className="space-y-1.5">
      <div>
        <label className="text-sm font-medium text-daintree-text">Fallback presets</label>
        <p className="text-xs text-daintree-text/40 select-text">
          Tried in order if this preset's provider is unreachable. No retry for rate limits or
          prompt errors.
        </p>
      </div>
      {chain.length > 0 && (
        <ul className="space-y-1">
          {chain.map((id, idx) => {
            const preset = allPresets.find((p) => p.id === id);
            const name = preset?.name ?? id;
            const missing = !preset;
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 px-2 py-1.5"
              >
                <span className="text-[10px] text-daintree-text/40 font-mono shrink-0">
                  {idx + 1}.
                </span>
                <span
                  className={
                    missing
                      ? "text-xs text-status-error truncate"
                      : "text-xs text-daintree-text truncate"
                  }
                >
                  {name}
                  {missing && " (missing)"}
                </span>
                <button
                  className="ml-auto text-daintree-text/30 hover:text-status-error transition-colors shrink-0"
                  onClick={() => removeFallback(id)}
                  aria-label={`Remove ${name} from fallback chain`}
                  title="Remove"
                >
                  <XIcon size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {chain.length < FALLBACK_CHAIN_MAX && candidates.length > 0 && (
        <select
          className="w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2 text-sm"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v) addFallback(v);
          }}
          aria-label="Add fallback preset"
        >
          <option value="">Add fallback preset…</option>
          {candidates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {chain.length >= FALLBACK_CHAIN_MAX && (
        <p className="text-[11px] text-daintree-text/40">
          Maximum of {FALLBACK_CHAIN_MAX} fallbacks reached.
        </p>
      )}
      {chain.length < FALLBACK_CHAIN_MAX && candidates.length === 0 && (
        <p className="text-[11px] text-daintree-text/40">
          No other presets available for this agent.
        </p>
      )}
    </div>
  );
}
