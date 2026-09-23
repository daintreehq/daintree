import { useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTerminalFontStore } from "@/store";
import { DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE } from "@/config/terminalFont";
import { actionService } from "@/services/ActionService";
import { SettingsSection } from "./SettingsSection";
import { SETTINGS_CONTROL_WIDTH, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsNumberInput } from "./SettingsNumberInput";
import { SettingsSubtabBar, subtabPanelProps } from "./SettingsSubtabBar";
import type { SettingsSubtabItem } from "./SettingsSubtabBar";
import { ColorSchemePicker, ImportColorSchemeButton } from "./ColorSchemePicker";
import { AppThemePicker } from "./AppThemePicker";
import { ColorVisionPicker } from "./ColorVisionPicker";
import { DockDensityPicker } from "./DockDensityPicker";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { logError } from "@/utils/logger";

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
  onClose?: () => void;
}

const DEFAULT_FONT_FAMILY_ID = "jetbrains";

const FONT_FAMILY_OPTIONS: Array<{ id: string; label: string; value: string }> = [
  {
    id: "jetbrains",
    label: "JetBrains Mono (default)",
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
  onClose,
}: TerminalAppearanceTabProps) {
  const effectiveSubtab =
    activeSubtab && APPEARANCE_SUBTABS.some((t) => t.id === activeSubtab) ? activeSubtab : "app";

  const fontSize = useTerminalFontStore((state) => state.fontSize);
  const fontFamily = useTerminalFontStore((state) => state.fontFamily);

  const [fontSizeInput, setFontSizeInput] = useState<string>(String(fontSize));
  const [fontSizeError, setFontSizeError] = useState<string | null>(null);

  // Report validation state to sidebar (only when terminal subtab is active)
  useSettingsTabValidation(
    "terminalAppearance",
    effectiveSubtab === "terminal" ? fontSizeError != null : false
  );

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

    await applyFontSize(parsed);
  };

  const applyFontSize = async (parsed: number) => {
    const previous = fontSize;
    setFontSizeError(null);
    setFontSizeInput(String(parsed));

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
      logError("Failed to persist terminal font size", error);
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
      logError("Failed to persist terminal font family", error);
    }
  };

  return (
    <>
      <SettingsSubtabBar
        subtabs={APPEARANCE_SUBTABS}
        activeId={effectiveSubtab}
        onChange={onSubtabChange}
        group="appearance"
        ariaLabel="Appearance settings sections"
      />

      <div {...subtabPanelProps("appearance", effectiveSubtab)} className="space-y-8">
        {effectiveSubtab === "app" && (
          <>
            <SettingsSection title="App theme" id="appearance-theme">
              <AppThemePicker onClose={onClose} />
            </SettingsSection>

            <SettingsSection title="Interface">
              <SettingsGroup>
                <ColorVisionPicker />
                <DockDensityPicker />
              </SettingsGroup>
            </SettingsSection>
          </>
        )}

        {effectiveSubtab === "terminal" && (
          <>
            <SettingsSection
              title="Terminal color scheme"
              description="Colors used for terminal output and ANSI escape sequences"
              id="appearance-color-scheme"
              action={<ImportColorSchemeButton />}
            >
              <ColorSchemePicker />
            </SettingsSection>

            <SettingsSection title="Font">
              <SettingsGroup>
                <SettingsRow
                  id="appearance-font-family"
                  label="Font family"
                  description="JetBrains Mono ships with Daintree; if it can't load, the terminal falls back to your platform's monospace font"
                  isModified={selectedFontFamilyId !== DEFAULT_FONT_FAMILY_ID}
                  onReset={() => void handleFontFamilyChange(DEFAULT_FONT_FAMILY_ID)}
                  control={({ descriptionId, disabled }) => (
                    <Select
                      value={selectedFontFamilyId}
                      onValueChange={(v) => void handleFontFamilyChange(v)}
                      disabled={disabled}
                    >
                      <SelectTrigger
                        aria-label="Terminal font family"
                        aria-describedby={descriptionId}
                        className={SETTINGS_CONTROL_WIDTH.wide}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FONT_FAMILY_OPTIONS.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <SettingsNumberInput
                  rowId="appearance-font-size"
                  label="Font size"
                  description={`${MIN_FONT_SIZE}–${MAX_FONT_SIZE}px. Smaller fonts put fewer cells on screen, which can improve performance.`}
                  isModified={fontSize !== DEFAULT_TERMINAL_FONT_SIZE}
                  onReset={() => void applyFontSize(DEFAULT_TERMINAL_FONT_SIZE)}
                  suffix="px"
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  value={fontSizeInput}
                  onChange={(e) => {
                    setFontSizeInput(e.target.value);
                    if (fontSizeError) {
                      setFontSizeError(null);
                    }
                  }}
                  onBlur={() => void handleFontSizeBlur()}
                  aria-label="Terminal font size"
                  error={fontSizeError ?? undefined}
                />
              </SettingsGroup>
            </SettingsSection>
          </>
        )}
      </div>
    </>
  );
}
