import { useEffect, useMemo, useState } from "react";
import { useTerminalColorSchemeStore, useTerminalFontStore } from "@/store";
import { useAppThemeStore } from "@/store/appThemeStore";
import { BUILT_IN_SCHEMES } from "@/config/terminalColorSchemes";
import { DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE } from "@/config/terminalFont";
import { actionService } from "@/services/ActionService";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsNumberInput } from "./SettingsNumberInput";
import { SettingsSubtabBar, subtabPanelProps } from "./SettingsSubtabBar";
import type { SettingsSubtabItem } from "./SettingsSubtabBar";
import {
  ColorSchemePicker,
  ImportColorSchemeButton,
  SchemePreview,
  resolveSchemeForPreview,
  type ColorSchemeError,
} from "./ColorSchemePicker";
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

type FontFamilyId = "jetbrains" | "system";

const DEFAULT_FONT_FAMILY_ID: FontFamilyId = "jetbrains";

const FONT_FAMILY_OPTIONS: Array<{ value: FontFamilyId; label: string; family: string }> = [
  { value: "jetbrains", label: "JetBrains Mono", family: DEFAULT_TERMINAL_FONT_FAMILY },
  { value: "system", label: "System monospace", family: SYSTEM_STACK },
];

interface FontError {
  title: string;
  retry: () => void;
}

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
  const [fontError, setFontError] = useState<FontError | null>(null);
  const [schemeError, setSchemeError] = useState<ColorSchemeError | null>(null);

  // Report validation state to sidebar (only when terminal subtab is active)
  useSettingsTabValidation(
    "terminalAppearance",
    effectiveSubtab === "terminal" ? fontSizeError != null : false
  );

  useEffect(() => {
    setFontSizeInput(String(fontSize));
  }, [fontSize]);

  const selectedFontFamilyId: FontFamilyId = fontFamily.includes("JetBrains Mono")
    ? "jetbrains"
    : "system";

  // A rejected size stays in the field beside its error, so what the user typed and
  // what is wrong with it are read together. The terminals keep the last applied size.
  const handleFontSizeBlur = async () => {
    const parsed = Number(fontSizeInput.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setFontSizeError("Font size must be a whole number");
      return;
    }
    if (parsed < MIN_FONT_SIZE || parsed > MAX_FONT_SIZE) {
      setFontSizeError(`Font size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE} px`);
      return;
    }

    if (parsed === fontSize) {
      setFontSizeError(null);
      return;
    }

    await applyFontSize(parsed);
  };

  const applyFontSize = async (parsed: number) => {
    setFontSizeError(null);
    setFontError(null);
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
      setFontSizeInput(String(useTerminalFontStore.getState().fontSize));
      setFontError({ title: "Couldn't save font size", retry: () => void applyFontSize(parsed) });
    }
  };

  const handleFontFamilyChange = async (value: FontFamilyId) => {
    const option = FONT_FAMILY_OPTIONS.find((opt) => opt.value === value);
    if (!option) return;
    setFontError(null);

    if (option.family === useTerminalFontStore.getState().fontFamily) return;

    try {
      const result = await actionService.dispatch(
        "terminalConfig.setFontFamily",
        { fontFamily: option.family },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      logError("Failed to persist terminal font family", error);
      setFontError({
        title: "Couldn't save font family",
        retry: () => void handleFontFamilyChange(value),
      });
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
              title="Color scheme"
              description="Hover or focus a scheme to preview it in your open terminals"
              id="appearance-color-scheme"
              action={<ImportColorSchemeButton onError={setSchemeError} />}
            >
              <ColorSchemePicker error={schemeError} onError={setSchemeError} />
            </SettingsSection>

            <SettingsSection title="Font">
              <SettingsGroup>
                <SettingsRow
                  id="appearance-font-family"
                  label="Font family"
                  description="Default: JetBrains Mono, which ships with Daintree. System uses Menlo, Monaco or Consolas."
                  isModified={selectedFontFamilyId !== DEFAULT_FONT_FAMILY_ID}
                  onReset={() => void handleFontFamilyChange(DEFAULT_FONT_FAMILY_ID)}
                  control={({ descriptionId, disabled }) => (
                    <SegmentedRadioGroup
                      aria-label="Terminal font family"
                      aria-describedby={descriptionId}
                      options={FONT_FAMILY_OPTIONS}
                      value={selectedFontFamilyId}
                      onChange={(v) => void handleFontFamilyChange(v)}
                      disabled={disabled}
                    />
                  )}
                />
                <SettingsNumberInput
                  rowId="appearance-font-size"
                  label="Font size"
                  description={`${MIN_FONT_SIZE}–${MAX_FONT_SIZE} px · Default: ${DEFAULT_TERMINAL_FONT_SIZE} px`}
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
                <FontSampleRow fontFamily={fontFamily} fontSize={fontSize} />
                {fontError && (
                  <div className="px-4 py-3">
                    <InlineStatusBanner
                      className="rounded-[var(--radius-md)]"
                      severity="error"
                      title={fontError.title}
                      description="Your terminals keep the last saved font, so nothing changes on restart."
                      action={{ id: "retry", label: "Retry", onClick: fontError.retry }}
                      onClose={() => setFontError(null)}
                      closeAriaLabel="Dismiss font error"
                    />
                  </div>
                )}
              </SettingsGroup>
            </SettingsSection>
          </>
        )}
      </div>
    </>
  );
}

/** The font settings drawn the way a terminal will: this family, this size, this palette. */
function FontSampleRow({ fontFamily, fontSize }: { fontFamily: string; fontSize: number }) {
  const selectedSchemeId = useTerminalColorSchemeStore((s) => s.selectedSchemeId);
  const customSchemes = useTerminalColorSchemeStore((s) => s.customSchemes);
  const appThemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const appCustomSchemes = useAppThemeStore((s) => s.customSchemes);

  const scheme = useMemo(() => {
    const all = [...BUILT_IN_SCHEMES, ...customSchemes];
    const selected = all.find((s) => s.id === selectedSchemeId) ?? BUILT_IN_SCHEMES[0]!;
    return resolveSchemeForPreview(selected, appThemeId, appCustomSchemes);
  }, [selectedSchemeId, customSchemes, appThemeId, appCustomSchemes]);

  return (
    <SettingsRow
      label="Preview"
      description={`${scheme.name} at ${fontSize} px`}
      layout="stacked"
      control={<SchemePreview scheme={scheme} fontFamily={fontFamily} fontSize={`${fontSize}px`} />}
    />
  );
}
