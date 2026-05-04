import { Copy } from "lucide-react";
import { stripCcrPrefix } from "./scopeUtils";
import type { AgentPreset } from "@/config/agents";

interface ReadOnlyDetailProps {
  scopeKind: "ccr" | "project";
  selectedPreset: AgentPreset;
  onDuplicate: (preset: AgentPreset) => void;
}

export function ReadOnlyDetail({ scopeKind, selectedPreset, onDuplicate }: ReadOnlyDetailProps) {
  const displayName =
    scopeKind === "ccr" ? stripCcrPrefix(selectedPreset.name) : selectedPreset.name;

  return (
    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 divide-y divide-daintree-border/50">
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-daintree-text">{displayName}</span>
          <button
            className="ml-auto text-daintree-text/30 hover:text-daintree-text transition-colors"
            onClick={() => onDuplicate(selectedPreset)}
            aria-label={`Duplicate ${displayName}`}
            title="Duplicate as custom"
          >
            <Copy size={13} />
          </button>
        </div>
        {selectedPreset.env && Object.keys(selectedPreset.env).length > 0 && (
          <div className="space-y-1">
            {Object.entries(selectedPreset.env).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-daintree-text/50 shrink-0">{k}</span>
                <span className="text-daintree-text/30">=</span>
                <span className="text-daintree-accent/70 truncate">{v}</span>
              </div>
            ))}
          </div>
        )}
        {selectedPreset.description && (
          <p className="text-[11px] text-daintree-text/40 select-text">
            {selectedPreset.description}
          </p>
        )}
        {scopeKind === "project" && (
          <p className="text-[10px] text-daintree-text/40 select-text">
            Sourced from <code>.daintree/presets/</code> in this project.
          </p>
        )}
      </div>
      <div className="px-3 py-2">
        <p className="text-xs text-daintree-text/40 select-text">
          Read-only. Duplicate as custom to override behavioral settings or env.
        </p>
      </div>
    </div>
  );
}
