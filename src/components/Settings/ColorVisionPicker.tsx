import { useEffect, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import type { ColorVisionMode } from "@shared/types";
import { logError } from "@/utils/logger";

const COLOR_VISION_OPTIONS: Array<{ id: ColorVisionMode; label: string; description: string }> = [
  { id: "default", label: "Default", description: "No color adjustments" },
  {
    id: "red-green",
    label: "Red-Green",
    description: "Deuteranopia & Protanopia",
  },
  {
    id: "blue-yellow",
    label: "Blue-Yellow",
    description: "Tritanopia",
  },
];

const isColorVisionMode = (value: string): value is ColorVisionMode =>
  COLOR_VISION_OPTIONS.some((option) => option.id === value);

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
    <div className="flex items-center gap-1.5 mt-2">
      {SWATCH_TOKENS.map((token, i) => (
        <div key={token.var} className="flex flex-col items-center gap-0.5">
          <div
            className="w-6 h-6 rounded-sm border border-daintree-border/30"
            style={{ backgroundColor: colors[i] }}
            title={token.label}
          />
          <span className="text-[9px] text-daintree-text/40">{token.label}</span>
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

  return (
    <div>
      <Select
        value={colorVisionMode}
        onValueChange={(value) => {
          if (isColorVisionMode(value)) void handleChange(value);
        }}
      >
        <SelectTrigger aria-label="Color vision mode">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {COLOR_VISION_OPTIONS.map((option) => (
            <SelectItem key={option.id} value={option.id} description={option.description}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {failedMode && (
        <InlineStatusBanner
          className="mt-2 rounded-[var(--radius-md)]"
          severity="error"
          icon={AlertCircle}
          title="Couldn't save color vision mode"
          description="The mode was restored to the last saved one, so it won't be lost on restart."
          action={{ id: "retry", label: "Retry", onClick: () => void handleChange(failedMode) }}
          onClose={() => setFailedMode(null)}
          closeAriaLabel="Dismiss color vision error"
        />
      )}
      <SwatchPreview />
    </div>
  );
}
