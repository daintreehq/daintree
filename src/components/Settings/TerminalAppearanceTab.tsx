import { useEffect, useId, useMemo, useState } from "react";
import { Palette, Type, CaseSensitive, Eye, PanelBottom } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTerminalFontStore } from "@/store";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { actionService } from "@/services/ActionService";
import { SettingsSection } from "./SettingsSection";
import { SettingsSubtabBar } from "./SettingsSubtabBar";
import type { SettingsSubtabItem } from "./SettingsSubtabBar";
import { ColorSchemePicker } from "./ColorSchemePicker";
import { AppThemePicker } from "./AppThemePicker";
import { ColorVisionPicker } from "./ColorVisionPicker";
import { DockDensityPicker } from "./DockDensityPicker";

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;

const SYSTEM_STACK = "Menlo, Monaco, Consolas, monospace";

const APPEARANCE_SUBTABS: SettingsSubtabItem[] = [
  { id: "app", label: "App" },
  { id: "terminal", label: "Terminal" },
];

interface TerminalAppearanceTabProps {
  activeSubtab: string | null;
  onSubtabChange: (id: string) => void;
}

const FONT_FAMILY_OPTIONS: Array<{ id: string; label: string; value: string }> = [
  {
    id: "jetbrains",
    label: "JetBrains Mono (Default)",
    value: DEFAULT_TERMINAL_FONT_FAMILY,
  },
  {
    id: "system",
    label: "System monospace (Menlo/Monaco/Consolas)",
    value: SYSTEM_STACK,
  },
];

export function TerminalAppearanceTab({
  activeSubtab,
  onSubtabChange,
}: TerminalAppearanceTabProps) {
  const effectiveSubtab =
    activeSubtab && APPEARANCE_SUBTABS.some((t) => t.id === activeSubtab) ? activeSubtab : "app";

  const fontSize = useTerminalFontStore((state) => state.fontSize);
  const fontFamily = useTerminalFontStore((state) => state.fontFamily);

  const fontSizeErrorId = useId();
  const [fontSizeInput, setFontSizeInput] = useState<string>(String(fontSize));
  const [fontSizeError, setFontSizeError] = useState<string | null>(null);

  useEffect(() => {
    setFontSizeInput(String(fontSize));
  }, [fontSize]);

  const selectedFontFamilyId = useMemo(() => {
    if (fontFamily.includes("JetBrains Mono")) {
      return "jetbrains";
    }
    return "system";
  }, [fontFamily]);

  const handleFontSizeBlur = async () => {
    const parsed = Number(fontSizeInput.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setFontSizeInput(String(fontSize));
      setFontSizeError("Font size must be a whole number.");
      return;
    }
    if (parsed < MIN_FONT_SIZE || parsed > MAX_FONT_SIZE) {
      setFontSizeError(`Font size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}px.`);
      setFontSizeInput(String(fontSize));
      return;
    }

    if (parsed === fontSize) {
      setFontSizeError(null);
      return;
    }

    const previous = fontSize;
    setFontSizeError(null);

    try {
      const result = await actionService.dispatch(
        "terminalConfig.setFontSize",
        { fontSize: parsed },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      console.error("Failed to persist terminal font size:", error);
      setFontSizeInput(String(previous));
      setFontSizeError("Failed to save font size.");
    }
  };

  const handleFontFamilyChange = async (value: string) => {
    const option = FONT_FAMILY_OPTIONS.find((opt) => opt.id === value);
    if (!option) return;

    const nextFamily = option.value;
    if (nextFamily === fontFamily) return;

    try {
      const result = await actionService.dispatch(
        "terminalConfig.setFontFamily",
        { fontFamily: nextFamily },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      console.error("Failed to persist terminal font family:", error);
    }
  };

  return (
    <>
      <SettingsSubtabBar
        subtabs={APPEARANCE_SUBTABS}
        activeId={effectiveSubtab}
        onChange={onSubtabChange}
      />

      <div className="space-y-6">
        {effectiveSubtab === "app" && (
          <>
            <SettingsSection
              icon={Palette}
              title="App Theme"
              description="Choose the overall visual theme for the application."
            >
              <AppThemePicker />
            </SettingsSection>

            <SettingsSection
              icon={Eye}
              title="Color Vision"
              description="Adjust colors for color vision deficiency. Affects status indicators and default terminal palette."
            >
              <ColorVisionPicker />
            </SettingsSection>

            <SettingsSection
              icon={PanelBottom}
              title="Dock Density"
              description="Control the height and spacing of items in the dock bar."
            >
              <DockDensityPicker />
            </SettingsSection>
          </>
        )}

        {effectiveSubtab === "terminal" && (
          <>
            <SettingsSection
              icon={Palette}
              title="Terminal Color Scheme"
              description="Colors used for terminal output and ANSI escape sequences."
            >
              <ColorSchemePicker />
            </SettingsSection>

            <SettingsSection
              icon={Type}
              title="Font Size"
              description="Terminal font size in pixels. Smaller fonts reduce the number of cells on screen and can improve performance."
            >
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  value={fontSizeInput}
                  onChange={(e) => {
                    setFontSizeInput(e.target.value);
                    if (fontSizeError) {
                      setFontSizeError(null);
                    }
                  }}
                  onBlur={handleFontSizeBlur}
                  className="bg-canopy-bg border border-border-interactive rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text w-24 focus:border-canopy-accent focus:outline-none transition-colors"
                  aria-label="Terminal font size"
                  aria-invalid={fontSizeError != null || undefined}
                  aria-describedby={fontSizeError ? fontSizeErrorId : undefined}
                />
                <span className="text-sm text-canopy-text/50">px</span>
                <span className="text-xs text-canopy-text/40 ml-auto">
                  Current: <span className="font-mono">{fontSize}px</span>
                </span>
              </div>
              {fontSizeError && (
                <p id={fontSizeErrorId} role="alert" className="text-xs text-status-error">
                  {fontSizeError}
                </p>
              )}
            </SettingsSection>

            <SettingsSection
              icon={CaseSensitive}
              title="Font Family"
              description="JetBrains Mono is bundled with Canopy. If it is not available on your system, the terminal will fall back to your platform's monospace font."
            >
              <select
                value={selectedFontFamilyId}
                onChange={(e) => handleFontFamilyChange(e.target.value)}
                className={cn(
                  "bg-canopy-bg border border-border-interactive rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text w-full focus:border-canopy-accent focus:outline-none transition-colors"
                )}
                aria-label="Terminal font family"
              >
                {FONT_FAMILY_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </SettingsSection>
          </>
        )}
      </div>
    </>
  );
}
