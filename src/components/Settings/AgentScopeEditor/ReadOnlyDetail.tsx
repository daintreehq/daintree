import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "../SettingsGroup";
import { stripCcrPrefix } from "./scopeUtils";
import type { AgentPreset } from "@/config/agents";
import { resolveDangerousMode, resolveInlineMode } from "@shared/types";
import { isSecretEnvEntry, maskSecretValue } from "@/utils/secretDetection";

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

  const value = (text: string) => <span className="text-sm text-text-primary">{text}</span>;

  // Keyed by preset as well as name, so switching presets never carries a
  // revealed value across.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const revealKey = (k: string) => `${selectedPreset.id}\u0000${k}`;
  const toggleReveal = (k: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      const id = revealKey(k);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
              {env.map(([k, v]) => {
                const secret = isSecretEnvEntry(k, v);
                const masked = secret && !revealed.has(revealKey(k));
                return (
                  <div key={k} className="contents">
                    <dt className="text-text-primary">{k}</dt>
                    {/* Wrapped, never truncated: an endpoint or model id is exactly
                        what someone opens this to read. A token is not — router
                        presets carry auth tokens, and this panel is read on shared
                        screens — so it is masked until asked for. */}
                    <dd className="flex min-w-0 items-start gap-2">
                      <span className="min-w-0 flex-1 break-all text-text-secondary">
                        {masked ? (
                          <>
                            <span aria-hidden="true">{maskSecretValue(v)}</span>
                            <span className="sr-only">Hidden</span>
                          </>
                        ) : (
                          v
                        )}
                      </span>
                      {secret && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="-my-1 shrink-0"
                          onClick={() => toggleReveal(k)}
                          aria-pressed={!masked}
                          aria-label={`Show value of ${k}`}
                          data-testid="preset-env-reveal"
                        >
                          {masked ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                        </Button>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          }
        />
      )}
      {args ? (
        <SettingsRow
          label="Custom arguments"
          description={presetSetsArgs ? fromPreset : fromAgent}
          layout="stacked"
          control={
            <code className="block whitespace-pre-wrap break-all font-mono text-xs text-text-primary select-text">
              {args}
            </code>
          }
        />
      ) : (
        <SettingsRow
          label="Custom arguments"
          description={presetSetsArgs ? fromPreset : fromAgent}
          control={value("None")}
        />
      )}
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
