import { useEffect, useRef, useState } from "react";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import type { ColorVisionMode } from "@shared/types";
import { logError } from "@/utils/logger";
import { SettingsRow } from "./SettingsGroup";

const COLOR_VISION_OPTIONS: Array<{ value: ColorVisionMode; label: string }> = [
  { value: "default", label: "Default" },
  { value: "red-green", label: "Red-green" },
  { value: "blue-yellow", label: "Blue-yellow" },
];

const DEFAULT_COLOR_VISION_MODE: ColorVisionMode = "default";

const SWATCH_TOKENS = [
  { label: "Success", var: "--theme-status-success" },
  { label: "Danger", var: "--theme-status-danger" },
  { label: "Warning", var: "--theme-status-warning" },
  { label: "Info", var: "--theme-status-info" },
  { label: "Active", var: "--theme-activity-active" },
  { label: "Keyword", var: "--theme-syntax-keyword" },
  { label: "String", var: "--theme-syntax-string" },
  { label: "Comment", var: "--theme-syntax-comment" },
];

function SwatchPreview() {
  const colorVisionMode = useAppThemeStore((s) => s.colorVisionMode);
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const [colors, setColors] = useState<string[]>([]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      setColors(SWATCH_TOKENS.map((t) => styles.getPropertyValue(t.var).trim()));
    });
    return () => cancelAnimationFrame(raf);
  }, [colorVisionMode, selectedSchemeId]);

  if (colors.length === 0) return null;

  return (
    <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5" aria-hidden="true">
      {SWATCH_TOKENS.map((token, i) => (
        <div key={token.var} className="flex w-12 flex-col items-center gap-1">
          <div
            className="w-6 h-6 rounded-sm border border-border-subtle"
            style={{ backgroundColor: colors[i] }}
            title={token.label}
          />
          <span className="text-2xs text-text-secondary">{token.label}</span>
        </div>
      ))}
    </div>
  );
}

export function ColorVisionPicker() {
  const colorVisionMode = useAppThemeStore((s) => s.colorVisionMode);
  const setColorVisionMode = useAppThemeStore((s) => s.setColorVisionMode);

  // The mode last known to be on disk. Seeded from the hydrated store on mount
  // and advanced only when a write lands, so a rollback restores durable truth
  // rather than an earlier optimistic value that never persisted.
  const confirmedModeRef = useRef(colorVisionMode);
  // Only the newest change may reconcile the field: an older rejection arriving
  // after a newer write succeeded must not drag the UI back.
  const epochRef = useRef(0);
  const [failedMode, setFailedMode] = useState<ColorVisionMode | null>(null);

  const handleChange = async (mode: ColorVisionMode) => {
    const epoch = ++epochRef.current;
    // A fresh choice retires the previous banner, so its Retry can't linger and
    // resurrect a superseded mode.
    setFailedMode(null);
    setColorVisionMode(mode);

    try {
      await appThemeClient.setColorVisionMode(mode);
      confirmedModeRef.current = mode;
      if (epoch === epochRef.current) setFailedMode(null);
    } catch (error) {
      logError("Failed to persist color vision mode", error);
      if (epoch !== epochRef.current) return;
      // Going back through the store setter (not a raw setState) re-runs the
      // documentElement filter swap, so the rendered colors match the mode the
      // app will actually boot with.
      setColorVisionMode(confirmedModeRef.current);
      setFailedMode(mode);
    }
  };

  // Three rows in the group: the setting, a preview of what it does, and — only after a
  // failed save — the error with its retry. The swatches used to hang under the row's
  // description in the left column while the select sat on the rail, so the row read as
  // two things at once.
  return (
    <>
      <SettingsRow
        id="appearance-color-vision"
        label="Color vision"
        description="Adjusts status and terminal colors. Red-green covers deuteranopia and protanopia; blue-yellow covers tritanopia."
        isModified={colorVisionMode !== DEFAULT_COLOR_VISION_MODE}
        onReset={() => void handleChange(DEFAULT_COLOR_VISION_MODE)}
        control={({ descriptionId, disabled }) => (
          <SegmentedRadioGroup
            aria-label="Color vision"
            aria-describedby={descriptionId}
            options={COLOR_VISION_OPTIONS}
            value={colorVisionMode}
            onChange={(mode) => void handleChange(mode)}
            disabled={disabled}
          />
        )}
      />
      <SettingsRow
        label="Preview"
        description="Status and syntax colors as the current mode draws them"
        layout="stacked"
        control={<SwatchPreview />}
      />
      {failedMode && (
        <div className="px-4 py-3">
          <InlineStatusBanner
            className="rounded-[var(--radius-md)]"
            severity="error"
            title="Couldn't save color vision mode"
            description="The mode was restored to the last saved one, so it won't be lost on restart."
            action={{ id: "retry", label: "Retry", onClick: () => void handleChange(failedMode) }}
            onClose={() => setFailedMode(null)}
            closeAriaLabel="Dismiss color vision error"
          />
        </div>
      )}
    </>
  );
}
