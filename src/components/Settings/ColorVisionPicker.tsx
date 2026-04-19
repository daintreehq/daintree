import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
      <Select value={colorVisionMode} onValueChange={(v) => void handleChange(v)}>
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
      <SwatchPreview />
    </div>
  );
}
