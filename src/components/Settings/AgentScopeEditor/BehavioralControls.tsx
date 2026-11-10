import { useMemo } from "react";
import { ShieldOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { SettingsRow } from "../SettingsGroup";
import type { ScopeKind } from "./scopeUtils";
import type { DangerousMode } from "@shared/types";

interface BehavioralControlsProps {
  scopeKind: ScopeKind;
  scopeLabel: string;
  /** Current bypass mode for the active scope (agent Default or preset). */
  dangerousMode: DangerousMode;
  /** Final resolved bypass for the active scope (incl. global baseline). */
  effectiveSkipPerms: boolean;
  /** What the "Default" (inherit) option resolves to, given the parent state. */
  inheritResolvesToOn: boolean;
  /** Where "Default" inherits from, or why the global setting doesn't reach this agent. */
  inheritHint: string;
  customArgsValue: string;
  customArgsPlaceholder: string;
  customArgsDescription: string;
  customFlagsOverride: string | undefined;
  defaultDangerousArg: string;
  onDangerousModeChange: (mode: DangerousMode) => void;
  onCustomFlagsChange: (value: string) => void;
  onCustomFlagsOverrideReset: () => void;
}

export function BehavioralControls({
  scopeKind,
  scopeLabel,
  dangerousMode,
  effectiveSkipPerms,
  inheritResolvesToOn,
  inheritHint,
  customArgsValue,
  customArgsPlaceholder,
  customArgsDescription,
  customFlagsOverride,
  defaultDangerousArg,
  onDangerousModeChange,
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

  return (
    <>
      <SettingsRow
        id="agents-custom-args"
        label="Custom arguments"
        description={customArgsDescription}
        layout="stacked"
        isModified={
          scopeKind === "custom" ? customFlagsOverride !== undefined : customArgsValue !== ""
        }
        onReset={
          scopeKind === "custom" ? onCustomFlagsOverrideReset : () => onCustomFlagsChange("")
        }
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
            Auto-approve all file, command and network actions. Off overrides the global setting for
            this scope.
            {dangerousMode === "inherit" && <span className="block mt-1">{inheritHint}</span>}
            {effectiveSkipPerms && defaultDangerousArg && (
              <span className="flex items-center gap-1.5 mt-1.5">
                <ShieldOff className="h-3.5 w-3.5 shrink-0 text-status-error" aria-hidden="true" />
                <code className="font-mono text-xs text-text-primary">{defaultDangerousArg}</code>
                <span>added to the command</span>
              </span>
            )}
          </>
        }
        isModified={dangerousMode !== "inherit"}
        onReset={() => onDangerousModeChange("inherit")}
        resetAriaLabel={`Reset skip permissions for ${scopeLabel} to default`}
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
    </>
  );
}
