import { EnvVarEditor } from "../EnvVarEditor";
import { SettingsRow } from "../SettingsGroup";
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
      <p className="text-2xs text-text-secondary pb-0.5">Available env overrides</p>
      {suggestions.map(({ key, hint }) => (
        <div key={key} className="flex items-baseline gap-2 font-mono">
          <span className="text-2xs text-text-secondary shrink-0">{key}</span>
          <span className="text-3xs text-text-placeholder">{hint}</span>
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
      <SettingsRow
        id="agents-global-env"
        label="Global env vars"
        description="Applied to every launch. Preset-specific vars take precedence"
        layout="stacked"
        control={
          <EnvVarEditor
            env={globalEnv ?? {}}
            onChange={onGlobalEnvChange}
            suggestions={suggestions}
            contextKey={`global-${agentId}`}
            data-testid="global-env-editor"
          />
        }
      />
    );
  }

  if (!selectedPreset) return null;

  return (
    <SettingsRow
      label="Env overrides"
      description="Override the global env vars for this preset only"
      layout="stacked"
      control={
        <div className="grid gap-2">
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
      }
    />
  );
}
