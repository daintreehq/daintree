import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import type { ColorVisionMode } from "@shared/types";

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

const SWATCH_TOKENS = [
  { label: "Success", var: "--theme-status-success" },
  { label: "Danger", var: "--theme-status-danger" },
  { label: "Warning", var: "--theme-status-warning" },
  { label: "Active", var: "--theme-activity-active" },
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
            className="w-6 h-6 rounded-sm border border-canopy-border/30"
            style={{ backgroundColor: colors[i] }}
            title={token.label}
          />
          <span className="text-[9px] text-canopy-text/40">{token.label}</span>
        </div>
      ))}
    </div>
  );
}

export function ColorVisionPicker() {
  const colorVisionMode = useAppThemeStore((s) => s.colorVisionMode);
  const setColorVisionMode = useAppThemeStore((s) => s.setColorVisionMode);

  const handleChange = useCallback(
    async (value: string) => {
      const mode = value as ColorVisionMode;
      setColorVisionMode(mode);
      try {
        await appThemeClient.setColorVisionMode(mode);
      } catch (error) {
        console.error("Failed to persist color vision mode:", error);
      }
    },
    [setColorVisionMode]
  );

  return (
    <div>
      <select
        value={colorVisionMode}
        onChange={(e) => handleChange(e.target.value)}
        className={cn(
          "bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text w-full focus:border-canopy-accent focus:outline-none transition-colors"
        )}
        aria-label="Color vision mode"
      >
        {COLOR_VISION_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label} — {option.description}
          </option>
        ))}
      </select>
      <SwatchPreview />
    </div>
  );
}
