import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsGroup } from "../SettingsGroup";
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
    <SettingsGroup>
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-text-primary">{displayName}</span>
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => onDuplicate(selectedPreset)}
            aria-label={`Duplicate ${displayName}`}
            title="Duplicate as custom"
          >
            <Copy />
          </Button>
        </div>
        {selectedPreset.env && Object.keys(selectedPreset.env).length > 0 && (
          <div className="space-y-1">
            {Object.entries(selectedPreset.env).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 font-mono text-2xs">
                <span className="text-text-secondary shrink-0">{k}</span>
                <span className="text-text-secondary">=</span>
                <span className="text-text-secondary truncate">{v}</span>
              </div>
            ))}
          </div>
        )}
        {selectedPreset.description && (
          <p className="text-2xs text-text-secondary select-text">{selectedPreset.description}</p>
        )}
        {scopeKind === "project" && (
          <p className="text-3xs text-text-secondary select-text">
            Sourced from <code>.daintree/presets/</code> in this project.
          </p>
        )}
      </div>
      <div className="px-4 py-3">
        <p className="text-xs text-text-secondary select-text">
          Read-only. Duplicate as custom to override behavioral settings or env
        </p>
      </div>
    </SettingsGroup>
  );
}
