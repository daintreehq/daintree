import { useMemo } from "react";
import { ShieldOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { SettingsRow } from "../SettingsGroup";
import type { ScopeKind } from "./scopeUtils";
import type { DangerousMode, PermissionLevel } from "@shared/types";
import { EXPLICIT_MODE_LABELS, PERMISSION_LEVEL_LABELS } from "@/lib/permissionLabels";

interface BehavioralControlsProps {
  scopeKind: ScopeKind;
  scopeLabel: string;
  /** Current permission mode for the active scope (agent Default or preset). */
  dangerousMode: DangerousMode;
  /** Final resolved level for the active scope (incl. global baseline). */
  effectiveLevel: PermissionLevel;
  /** The args that level adds to the command, space-separated; empty for none. */
  effectivePermissionArgs: string;
  /** Whether the agent declares its own Auto mode. */
  autoSupported: boolean;
  /** What the "Inherit" option resolves to, given the parent state. */
  inheritLevel: PermissionLevel;
  /** Where "Inherit" inherits from, or why the global setting doesn't reach this agent. */
  inheritHint: string;
  customArgsValue: string;
  customArgsPlaceholder: string;
  customArgsDescription: string;
  customFlagsOverride: string | undefined;
  onDangerousModeChange: (mode: DangerousMode) => void;
  onCustomFlagsChange: (value: string) => void;
  onCustomFlagsOverrideReset: () => void;
}

export function BehavioralControls({
  scopeKind,
  scopeLabel,
  dangerousMode,
  effectiveLevel,
  effectivePermissionArgs,
  autoSupported,
  inheritLevel,
  inheritHint,
  customArgsValue,
  customArgsPlaceholder,
  customArgsDescription,
  customFlagsOverride,
  onDangerousModeChange,
  onCustomFlagsChange,
  onCustomFlagsOverrideReset,
}: BehavioralControlsProps) {
  // The inherit segment carries what it resolves to, so the rail alone says what the
  // agent will actually get without reading the description. Auto is offered only
  // where the agent declares it; a saved Auto it can't honour stays visible, disabled,
  // so it can be read and changed.
  const showAuto = autoSupported || dangerousMode === "auto";
  const dangerousModeOptions = useMemo<SegmentedRadioOption<DangerousMode>[]>(
    () => [
      { value: "inherit", label: `Inherit (${PERMISSION_LEVEL_LABELS[inheritLevel]})` },
      { value: "off", label: EXPLICIT_MODE_LABELS.off },
      ...(showAuto
        ? [{ value: "auto" as const, label: EXPLICIT_MODE_LABELS.auto, disabled: !autoSupported }]
        : []),
      { value: "on", label: EXPLICIT_MODE_LABELS.on },
    ],
    [inheritLevel, showAuto, autoSupported]
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
        label="Permission prompts"
        description={
          <>
            {autoSupported
              ? "Auto lets the agent approve actions under its own rules; Skip all approves every file, command and network action. A choice here overrides the global setting for this scope."
              : "Skip all approves every file, command and network action. A choice here overrides the global setting for this scope."}
            {dangerousMode === "inherit" && <span className="block mt-1">{inheritHint}</span>}
            {dangerousMode === "auto" && !autoSupported && (
              <span className="block mt-1">
                This agent has no Auto mode, so it launches with its CLI default
              </span>
            )}
            {effectivePermissionArgs && (
              <span className="flex items-center gap-1.5 mt-1.5">
                {effectiveLevel === "skip" && (
                  <ShieldOff className="h-3.5 w-3.5 shrink-0 text-status-error" aria-hidden="true" />
                )}
                <code className="font-mono text-xs text-text-primary">
                  {effectivePermissionArgs}
                </code>
                <span>added to the command</span>
              </span>
            )}
          </>
        }
        isModified={dangerousMode !== "inherit"}
        onReset={() => onDangerousModeChange("inherit")}
        resetAriaLabel={`Reset permission prompts for ${scopeLabel} to default`}
        control={({ descriptionId, disabled }) => (
          <SegmentedRadioGroup<DangerousMode>
            aria-label="Permission prompts"
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
