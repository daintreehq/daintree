import { RotateCcw } from "lucide-react";
import { SettingsSwitchCard } from "../SettingsSwitchCard";
import type { ScopeKind } from "./scopeUtils";

interface BehavioralControlsProps {
  scopeKind: ScopeKind;
  scopeLabel: string;
  effectiveSkipPerms: boolean;
  effectiveInlineMode: boolean;
  agentDefaultDangerous: boolean;
  agentDefaultInline: boolean;
  customArgsValue: string;
  customArgsPlaceholder: string;
  customArgsDescription: string;
  dangerousOverride: boolean | undefined;
  inlineOverride: boolean | undefined;
  customFlagsOverride: string | undefined;
  supportsInlineMode: boolean;
  defaultDangerousArg: string;
  onSkipPermsChange: () => void;
  onInlineModeChange: () => void;
  onCustomFlagsChange: (value: string) => void;
  onDangerousOverrideReset: () => void;
  onInlineOverrideReset: () => void;
  onCustomFlagsOverrideReset: () => void;
}

export function BehavioralControls({
  scopeKind,
  scopeLabel,
  effectiveSkipPerms,
  effectiveInlineMode,
  agentDefaultDangerous,
  agentDefaultInline,
  customArgsValue,
  customArgsPlaceholder,
  customArgsDescription,
  dangerousOverride,
  inlineOverride,
  customFlagsOverride,
  supportsInlineMode,
  defaultDangerousArg,
  onSkipPermsChange,
  onInlineModeChange,
  onCustomFlagsChange,
  onDangerousOverrideReset,
  onInlineOverrideReset,
  onCustomFlagsOverrideReset,
}: BehavioralControlsProps) {
  return (
    <>
      <div id="agents-skip-permissions" className="space-y-1.5">
        <SettingsSwitchCard
          variant="compact"
          title="Skip Permissions"
          subtitle={
            scopeKind === "custom" && dangerousOverride === undefined
              ? `Using default (${agentDefaultDangerous ? "On" : "Off"})`
              : "Auto-approve all file, command, and network actions"
          }
          isEnabled={effectiveSkipPerms}
          onChange={onSkipPermsChange}
          ariaLabel={`Skip permissions for ${scopeLabel}`}
          colorScheme="danger"
          isModified={scopeKind === "custom" && dangerousOverride !== undefined}
          onReset={scopeKind === "custom" ? onDangerousOverrideReset : undefined}
          resetAriaLabel={
            scopeKind === "custom" ? `Reset skip permissions override for ${scopeLabel}` : undefined
          }
        />
        {effectiveSkipPerms && defaultDangerousArg && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
            <code className="text-xs text-status-error font-mono">{defaultDangerousArg}</code>
            <span className="text-xs text-daintree-text/40">added to command</span>
          </div>
        )}
      </div>

      {supportsInlineMode && (
        <div id="agents-inline-mode">
          <SettingsSwitchCard
            variant="compact"
            title="Inline Mode"
            subtitle={
              scopeKind === "custom" && inlineOverride === undefined
                ? `Using default (${agentDefaultInline ? "On" : "Off"})`
                : "Disable fullscreen TUI for better resize handling and scrollback"
            }
            isEnabled={effectiveInlineMode}
            onChange={onInlineModeChange}
            ariaLabel={`Inline mode for ${scopeLabel}`}
            isModified={scopeKind === "custom" && inlineOverride !== undefined}
            onReset={scopeKind === "custom" ? onInlineOverrideReset : undefined}
            resetAriaLabel={
              scopeKind === "custom" ? `Reset inline mode override for ${scopeLabel}` : undefined
            }
          />
        </div>
      )}

      <div id="agents-custom-args" className="group/args space-y-1.5">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-daintree-text">Custom Arguments</label>
          {scopeKind === "custom" && customFlagsOverride !== undefined && (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-state-modified" aria-hidden="true" />
              <button
                type="button"
                aria-label={`Reset custom arguments override for ${scopeLabel}`}
                className="p-0.5 rounded-sm text-daintree-text/40 hover:text-daintree-text invisible group-hover/args:visible group-focus-within/args:visible focus-visible:visible focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent transition-colors"
                onClick={onCustomFlagsOverrideReset}
                data-testid="preset-custom-flags-reset"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            </>
          )}
        </div>
        <input
          className="w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 placeholder:text-text-muted"
          value={customArgsValue}
          onChange={(e) => onCustomFlagsChange(e.target.value)}
          placeholder={customArgsPlaceholder}
          data-testid={scopeKind === "custom" ? "preset-custom-flags-input" : undefined}
        />
        <p className="text-xs text-daintree-text/40 select-text">{customArgsDescription}</p>
      </div>
    </>
  );
}
