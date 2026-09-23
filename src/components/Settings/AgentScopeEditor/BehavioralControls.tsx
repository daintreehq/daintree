import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
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
  // The inherit segment carries what it resolves to, so the rail alone says what the
  // agent will actually get without reading the description.
  const dangerousModeOptions = useMemo<SegmentedRadioOption<DangerousMode>[]>(
    () => [
      { value: "inherit", label: `Default (${inheritResolvesToOn ? "On" : "Off"})` },
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ],
    [inheritResolvesToOn]
  );

  // Alt-screen tri-state. Labels describe the effect ("Inline" / "Alt screen")
  // and are decoupled from the stored `inlineMode` value polarity ("on" = inline,
  // "off" = alt screen) so the field name and its values stay self-consistent.
  const inlineModeOptions = useMemo<SegmentedRadioOption<InlineMode>[]>(
    () => [
      {
        value: "inherit",
        label: `Default (${inlineInheritResolvesToInline ? "Inline" : "Alt screen"})`,
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
        description={
          <>
            Auto-approve all file, command, and network actions. Off vetoes the global setting for
            this scope
            {dangerousMode === "inherit" && (
              <span className="block mt-1">Inherited from {inheritOriginLabel}</span>
            )}
            {effectiveSkipPerms && defaultDangerousArg && (
              <span className="flex items-center gap-2 mt-1.5">
                <code className="text-xs text-status-error font-mono">{defaultDangerousArg}</code>
                <span>added to command</span>
              </span>
            )}
          </>
        }
        control={({ descriptionId, disabled }) => (
          <SegmentedRadioGroup<DangerousMode>
            aria-label="Skip permissions"
            aria-describedby={descriptionId}
            value={dangerousMode}
            onChange={onDangerousModeChange}
            options={dangerousModeOptions}
            disabled={disabled}
          />
        )}
      />

      {supportsInlineMode && (
        <SettingsRow
          id="agents-inline-mode"
          label="Alt-screen mode"
          description={
            <>
              Alt screen uses the CLI&apos;s full-screen TUI; inline keeps output in Daintree&apos;s
              scrollback with cleaner resizing. Choosing Inline or Alt screen overrides the
              inherited setting for this scope
              {inlineMode === "inherit" && (
                <span className="block mt-1">Inherited from {inlineInheritOriginLabel}</span>
              )}
            </>
          }
          control={({ descriptionId, disabled }) => (
            <SegmentedRadioGroup<InlineMode>
              aria-label="Alt-screen mode"
              aria-describedby={descriptionId}
              value={inlineMode}
              onChange={onInlineModeChange}
              options={inlineModeOptions}
              disabled={disabled}
            />
          )}
        />
      )}
    </>
  );
}
