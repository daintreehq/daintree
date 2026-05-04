import { EnvVarEditor } from "../EnvVarEditor";
import type { AgentPreset } from "@/config/agents";

type EnvSuggestion = { key: string; hint: string };

interface EnvBlockProps {
  scopeKind: "default" | "custom";
  agentId: string;
  globalEnv: Record<string, string> | undefined;
  selectedPreset: AgentPreset | undefined;
  suggestions: EnvSuggestion[];
  onGlobalEnvChange: (env: Record<string, string>) => void;
  onPresetEnvChange: (env: Record<string, string>) => void;
}

function EnvVarReference({ suggestions }: { suggestions: EnvSuggestion[] }) {
  return (
    <div className="space-y-0.5 pt-1">
      <p className="text-[11px] text-daintree-text/40 pb-0.5">Available env overrides:</p>
      {suggestions.map(({ key, hint }) => (
        <div key={key} className="flex items-baseline gap-2 font-mono">
          <span className="text-[11px] text-daintree-text/60 shrink-0">{key}</span>
          <span className="text-[10px] text-daintree-text/30">{hint}</span>
        </div>
      ))}
    </div>
  );
}

export function EnvBlock({
  scopeKind,
  agentId,
  globalEnv,
  selectedPreset,
  suggestions,
  onGlobalEnvChange,
  onPresetEnvChange,
}: EnvBlockProps) {
  if (scopeKind === "default") {
    return (
      <div id="agents-global-env" className="space-y-2">
        <div>
          <label className="text-sm font-medium text-daintree-text">Global env vars</label>
          <p className="text-xs text-daintree-text/40 select-text">
            Applied to every launch. Preset-specific vars take precedence.
          </p>
        </div>
        <EnvVarEditor
          env={globalEnv ?? {}}
          onChange={onGlobalEnvChange}
          suggestions={suggestions}
          contextKey={`global-${agentId}`}
          data-testid="global-env-editor"
        />
      </div>
    );
  }

  if (!selectedPreset) return null;

  return (
    <>
      <div className="space-y-1.5">
        <span className="text-[11px] text-daintree-text/50 font-medium uppercase tracking-wide block">
          Env overrides
        </span>
        <EnvVarEditor
          env={selectedPreset.env ?? {}}
          onChange={onPresetEnvChange}
          suggestions={suggestions}
          contextKey={selectedPreset.id}
          inheritedEnv={globalEnv}
          data-testid="preset-env-editor"
        />
        <EnvVarReference suggestions={suggestions} />
      </div>
    </>
  );
}
