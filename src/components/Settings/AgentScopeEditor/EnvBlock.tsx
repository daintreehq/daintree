import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { EnvVarEditor } from "../EnvVarEditor";
import { SettingsRow } from "../SettingsGroup";
import type { AgentPreset } from "@/config/agents";

type EnvSuggestion = { key: string; hint: string };

interface EnvBlockProps {
  scopeKind: "default" | "custom";
  agentId: string;
  agentName: string;
  globalEnv: Record<string, string> | undefined;
  selectedPreset: AgentPreset | undefined;
  suggestions: EnvSuggestion[];
  onGlobalEnvChange: (env: Record<string, string>) => void;
  onPresetEnvChange: (env: Record<string, string>) => void;
}

/**
 * The variables this agent reads, as reference. Useful while filling in a preset and
 * noise the rest of the time, so it stays closed until asked for.
 */
function EnvVarReference({ suggestions }: { suggestions: EnvSuggestion[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (suggestions.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="group flex items-center gap-1.5 rounded-[var(--radius-sm)] text-xs text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-150",
            open ? "rotate-90" : "rotate-0"
          )}
          aria-hidden="true"
        />
        {open
          ? "Hide variables this agent reads"
          : `Variables this agent reads (${suggestions.length})`}
      </button>
      <div id={listId}>
        {open && (
          <dl className="mt-2 grid gap-1 select-text">
            {suggestions.map(({ key, hint }) => (
              <div key={key} className="flex min-w-0 items-baseline gap-2">
                <dt className="shrink-0 font-mono text-xs text-text-primary">{key}</dt>
                <dd className="min-w-0 text-xs text-text-secondary">{hint}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

export function EnvBlock({
  scopeKind,
  agentId,
  agentName,
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
        label="Environment variables"
        description={`Set for every ${agentName} launch. A preset's own variables take precedence.`}
        layout="stacked"
        control={
          <div className="grid gap-2">
            <EnvVarEditor
              env={globalEnv ?? {}}
              onChange={onGlobalEnvChange}
              suggestions={suggestions}
              contextKey={`global-${agentId}`}
              data-testid="global-env-editor"
            />
            <EnvVarReference suggestions={suggestions} />
          </div>
        }
      />
    );
  }

  if (!selectedPreset) return null;

  return (
    <SettingsRow
      label="Environment variables"
      description={`Added to ${agentName}'s own variables for this preset, replacing any with the same name`}
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
