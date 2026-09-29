import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
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
// Stepper clicks and held arrow keys fire a change per step; the sample follows each one,
// but the setting (and every open terminal's refit) waits for the steps to settle.
const LIVE_FONT_SIZE_DEBOUNCE_MS = 250;

type FontSizeParse = { ok: true; value: number } | { ok: false; error: string };

function parseFontSize(raw: string): FontSizeParse {
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { ok: false, error: "Font size must be a whole number" };
  }
  if (parsed < MIN_FONT_SIZE || parsed > MAX_FONT_SIZE) {
    return {
      ok: false,
      error: `Font size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE} px`,
    };
  }
  return { ok: true, value: parsed };
}

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

  const selectedFontFamilyId: FontFamilyId = fontFamily.includes("JetBrains Mono")
    ? "jetbrains"
    : "system";

  const liveApplyRef = useRef<{ timer: ReturnType<typeof setTimeout>; flush: () => void } | null>(
    null
  );

  const cancelLiveApply = () => {
    if (liveApplyRef.current) {
      clearTimeout(liveApplyRef.current.timer);
      liveApplyRef.current = null;
    }
  };

  // A size changed from anywhere else (a zoom shortcut, another window) outranks a
  // draft still waiting on its debounce, which would otherwise save over it.
  useEffect(() => {
    cancelLiveApply();
    setFontSizeInput(String(fontSize));
  }, [fontSize]);

  // A step the user saw in the sample is a step they expect kept, even if the dialog
  // closes before the debounce settles.
  useEffect(() => {
    const live = liveApplyRef;
    return () => {
      const pending = live.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      live.current = null;
      pending.flush();
    };
  }, []);

  // A rejected size stays in the field beside its error, so what the user typed and
  // what is wrong with it are read together. The terminals keep the last applied size.
  const commitFontSize = async () => {
    cancelLiveApply();
    const result = parseFontSize(fontSizeInput);
    if (!result.ok) {
      setFontSizeError(result.error);
      return;
    }

    if (result.value === fontSize) {
      setFontSizeError(null);
      return;
    }

    await applyFontSize(result.value);
  };

  const handleFontSizeChange = (raw: string) => {
    setFontSizeInput(raw);
    if (fontSizeError) {
      setFontSizeError(null);
    }
    cancelLiveApply();
    const result = parseFontSize(raw);
    if (!result.ok || result.value === fontSize) return;
    const flush = () => void applyFontSize(result.value);
    liveApplyRef.current = {
      timer: setTimeout(() => {
        liveApplyRef.current = null;
        flush();
      }, LIVE_FONT_SIZE_DEBOUNCE_MS),
      flush,
    };
  };

  const handleFontSizeKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void commitFontSize();
      return;
    }
    if (e.key === "Escape" && fontSizeInput !== String(fontSize)) {
      // Revert the draft first; only an already-clean field lets Escape close the dialog.
      e.preventDefault();
      e.stopPropagation();
      cancelLiveApply();
      setFontSizeInput(String(fontSize));
      setFontSizeError(null);
    }
  };

  const draftFontSize = parseFontSize(fontSizeInput);
  const sampleFontSize = draftFontSize.ok ? draftFontSize.value : fontSize;

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
                  onReset={() => {
                    cancelLiveApply();
                    void applyFontSize(DEFAULT_TERMINAL_FONT_SIZE);
                  }}
                  suffix="px"
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  value={fontSizeInput}
                  onChange={(e) => handleFontSizeChange(e.target.value)}
                  onKeyDown={handleFontSizeKeyDown}
                  onBlur={() => void commitFontSize()}
                  aria-label="Terminal font size"
                  error={fontSizeError ?? undefined}
                />
                <FontSampleRow fontFamily={fontFamily} fontSize={sampleFontSize} />
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
