import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { SettingsChoicebox, type ChoiceboxOption } from "../SettingsChoicebox";
import { SettingsRow } from "../SettingsGroup";
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
  /** Where the inline "Default" inherits from — "global setting", "agent default", or "the agent's built-in default" (a curated registry default that shadows the global switch, #10894). */
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
      <SettingsRow
        id="agents-custom-args"
        label="Custom arguments"
        description={customArgsDescription}
        layout="stacked"
        isModified={scopeKind === "custom" && customFlagsOverride !== undefined}
        onReset={onCustomFlagsOverrideReset}
        resetAriaLabel={`Reset custom arguments override for ${scopeLabel}`}
        control={({ labelId, descriptionId }) => (
          <Input
            className="font-mono"
            value={customArgsValue}
            onChange={(e) => onCustomFlagsChange(e.target.value)}
            placeholder={customArgsPlaceholder}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            data-testid={scopeKind === "custom" ? "preset-custom-flags-input" : undefined}
          />
        )}
      />

      <SettingsRow
        id="agents-skip-permissions"
        label="Skip permissions"
        description="Auto-approve all file, command, and network actions. Off vetoes the global setting for this scope"
        layout="stacked"
        control={
          <div className="grid gap-2">
            <SettingsChoicebox<DangerousMode>
              aria-label="Skip permissions"
              columns={3}
              value={dangerousMode}
              onChange={onDangerousModeChange}
              options={dangerousModeOptions}
            />
            {dangerousMode === "inherit" && (
              <p className="text-xs text-text-secondary select-text">
                Inherited from {inheritOriginLabel}
              </p>
            )}
            {effectiveSkipPerms && defaultDangerousArg && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
                <code className="text-xs text-status-error font-mono">{defaultDangerousArg}</code>
                <span className="text-xs text-text-secondary">added to command</span>
              </div>
            )}
          </div>
        }
      />

      {supportsInlineMode && (
        <SettingsRow
          id="agents-inline-mode"
          label="Alt-screen mode"
          description="Alt screen uses the CLI's full-screen TUI; inline keeps output in Daintree's scrollback with cleaner resizing. Choosing Inline or Alt screen overrides the inherited setting for this scope"
          layout="stacked"
          control={
            <div className="grid gap-2">
              <SettingsChoicebox<InlineMode>
                aria-label="Alt-screen mode"
                columns={3}
                value={inlineMode}
                onChange={onInlineModeChange}
                options={inlineModeOptions}
              />
              {inlineMode === "inherit" && (
                <p className="text-xs text-text-secondary select-text">
                  Inherited from {inlineInheritOriginLabel}
                </p>
              )}
            </div>
          }
        />
      )}
    </>
  );
}
