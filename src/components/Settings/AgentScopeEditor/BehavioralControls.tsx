import { useMemo } from "react";
import { RotateCcw } from "lucide-react";
import { SettingsChoicebox, type ChoiceboxOption } from "../SettingsChoicebox";
import type { ScopeKind } from "./scopeUtils";
import type { DangerousMode, InlineMode } from "@shared/types";

interface BehavioralControlsProps {
  scopeKind: ScopeKind;
  scopeLabel: string;
  /** Current bypass mode for the active scope (agent Default or preset). */
  dangerousMode: DangerousMode;
  /** Final resolved bypass for the active scope (incl. global baseline). */
  effectiveSkipPerms: boolean;
  /** What the "Default" (inherit) option resolves to, given the parent state. */
  inheritResolvesToOn: boolean;
  /** Where "Default" inherits from — "global setting" or "agent default". */
  inheritOriginLabel: string;
  /** Current alt-screen mode for the active scope (agent Default or preset). */
  inlineMode: InlineMode;
  /** Whether the inline "Default" (inherit) option resolves to inline (vs alt screen). */
  inlineInheritResolvesToInline: boolean;
  /** Where the inline "Default" inherits from — "global setting" or "agent default". */
  inlineInheritOriginLabel: string;
  customArgsValue: string;
  customArgsPlaceholder: string;
  customArgsDescription: string;
  customFlagsOverride: string | undefined;
  supportsInlineMode: boolean;
  defaultDangerousArg: string;
  onDangerousModeChange: (mode: DangerousMode) => void;
  onInlineModeChange: (mode: InlineMode) => void;
  onCustomFlagsChange: (value: string) => void;
  onCustomFlagsOverrideReset: () => void;
}

export function BehavioralControls({
  scopeKind,
  scopeLabel,
  dangerousMode,
  effectiveSkipPerms,
  inheritResolvesToOn,
  inheritOriginLabel,
  inlineMode,
  inlineInheritResolvesToInline,
  inlineInheritOriginLabel,
  customArgsValue,
  customArgsPlaceholder,
  customArgsDescription,
  customFlagsOverride,
  supportsInlineMode,
  defaultDangerousArg,
  onDangerousModeChange,
  onInlineModeChange,
  onCustomFlagsChange,
  onCustomFlagsOverrideReset,
}: BehavioralControlsProps) {
  const dangerousModeOptions = useMemo<ReadonlyArray<ChoiceboxOption<DangerousMode>>>(
    () => [
      {
        value: "inherit",
        label: "Default",
        resolvedLabel: `(${inheritResolvesToOn ? "On" : "Off"})`,
        muted: true,
      },
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ],
    [inheritResolvesToOn]
  );

  // Alt-screen tri-state. Labels describe the effect ("Inline" / "Alt screen")
  // and are decoupled from the stored `inlineMode` value polarity ("on" = inline,
  // "off" = alt screen) so the field name and its values stay self-consistent.
  const inlineModeOptions = useMemo<ReadonlyArray<ChoiceboxOption<InlineMode>>>(
    () => [
      {
        value: "inherit",
        label: "Default",
        resolvedLabel: `(${inlineInheritResolvesToInline ? "Inline" : "Alt screen"})`,
        muted: true,
      },
      { value: "on", label: "Inline" },
      { value: "off", label: "Alt screen" },
    ],
    [inlineInheritResolvesToInline]
  );

  return (
    <>
      <div id="agents-custom-args" className="group/args space-y-1.5">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-daintree-text">Custom arguments</label>
          {scopeKind === "custom" && customFlagsOverride !== undefined && (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-state-modified" aria-hidden="true" />
              <button
                type="button"
                aria-label={`Reset custom arguments override for ${scopeLabel}`}
                className="p-0.5 rounded-sm text-daintree-text/40 hover:text-daintree-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent transition-colors"
                onClick={onCustomFlagsOverrideReset}
                data-testid="preset-custom-flags-reset"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            </>
          )}
        </div>
        <input
          className="w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 placeholder:text-text-placeholder"
          value={customArgsValue}
          onChange={(e) => onCustomFlagsChange(e.target.value)}
          placeholder={customArgsPlaceholder}
          data-testid={scopeKind === "custom" ? "preset-custom-flags-input" : undefined}
        />
        <p className="text-xs text-daintree-text/40 select-text">{customArgsDescription}</p>
      </div>

      <div id="agents-skip-permissions" className="space-y-1.5">
        <SettingsChoicebox<DangerousMode>
          label="Skip permissions"
          description="Auto-approve all file, command, and network actions. Off vetoes the global setting for this scope."
          columns={3}
          value={dangerousMode}
          onChange={onDangerousModeChange}
          options={dangerousModeOptions}
        />
        {dangerousMode === "inherit" && (
          <p className="text-xs text-daintree-text/40 select-text">
            Inherited from {inheritOriginLabel}
          </p>
        )}
        {effectiveSkipPerms && defaultDangerousArg && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
            <code className="text-xs text-status-error font-mono">{defaultDangerousArg}</code>
            <span className="text-xs text-daintree-text/40">added to command</span>
          </div>
        )}
      </div>

      {supportsInlineMode && (
        <div id="agents-inline-mode" className="space-y-1.5">
          <SettingsChoicebox<InlineMode>
            label="Alt-screen mode"
            description="Alt screen matches the CLI's native full-screen TUI; inline is smoother (WebGL scrollback, clean resize). Off vetoes the global setting for this scope."
            columns={3}
            value={inlineMode}
            onChange={onInlineModeChange}
            options={inlineModeOptions}
          />
          {inlineMode === "inherit" && (
            <p className="text-xs text-daintree-text/40 select-text">
              Inherited from {inlineInheritOriginLabel}
            </p>
          )}
        </div>
      )}
    </>
  );
}
