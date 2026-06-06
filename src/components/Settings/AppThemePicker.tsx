import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import { AlertTriangle, Monitor, Shuffle } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { injectSchemeToDOM, useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { runThemeReveal } from "@/lib/appThemeViewTransition";
import {
  accentOverrideHasLowContrast,
  applyAccentOverrideToScheme,
  resolveAppTheme,
} from "@shared/theme";
import { PaletteStrip } from "@/components/ui/PaletteStrip";
import { Button } from "@/components/ui/button";
import { APP_THEME_PREVIEW_KEYS } from "@shared/theme";
import type {
  AppColorScheme,
  AppThemeValidationWarning,
  AppThemeWarningKind,
} from "@shared/types/appTheme";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logError } from "@/utils/logger";
import { useImageError } from "@/hooks/useImageError";

// Plain-language summary per warning kind. Engine diagnostics (contrast ratios,
// WCAG clause numbers, token-key names) are written for theme authors, not end
// users — they stay behind the "Technical details" disclosure. The Record forces
// every AppThemeWarningKind to have copy (a missing key is a compile error).
const WARNING_KIND_COPY: Record<AppThemeWarningKind, string> = {
  "type-inferred": "Theme mode was guessed from the colors",
  "unknown-tokens": "Some values in this theme weren't recognized",
  "low-contrast": "Some colors may be hard to see",
  "terminal-legibility": "Some terminal colors may be hard to read",
  unevaluable: "Some colors couldn't be checked",
  "accent-rgb-fallback": "Accent tint colors may not render correctly",
  "overlay-contrast": "Hover highlights may be hard to see",
};

// Collapse the flat warning list to one entry per kind (first-seen order), so the
// import result reads as a short scannable list instead of N near-identical rows.
// Raw messages are grouped under their kind for the technical-details disclosure.
function groupWarningsByKind(
  warnings: AppThemeValidationWarning[]
): Array<{ kind: AppThemeWarningKind; messages: string[] }> {
  const order: AppThemeWarningKind[] = [];
  const byKind = new Map<AppThemeWarningKind, string[]>();
  for (const warning of warnings) {
    let messages = byKind.get(warning.kind);
    if (!messages) {
      messages = [];
      byKind.set(warning.kind, messages);
      order.push(warning.kind);
    }
    messages.push(warning.message);
  }
  return order.map((kind) => ({ kind, messages: byKind.get(kind)! }));
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function persistCustomSchemes() {
  const { customSchemes } = useAppThemeStore.getState();
  await appThemeClient.setCustomSchemes(customSchemes);
}

function PreferredSchemePicker({
  label,
  schemes,
  selectedId,
  onSelect,
}: {
  label: string;
  schemes: AppColorScheme[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium uppercase tracking-wider text-daintree-text/40">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {schemes.map((scheme) => (
          <button
            key={scheme.id}
            type="button"
            onClick={() => onSelect(scheme.id)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-md)] border text-xs transition-colors",
              selectedId === scheme.id
                ? "border-border-strong bg-overlay-medium text-daintree-text"
                : "border-daintree-border text-daintree-text/70 hover:bg-surface-hover"
            )}
          >
            <div
              className="w-3 h-3 rounded-sm shrink-0"
              style={{ backgroundColor: scheme.tokens[APP_THEME_PREVIEW_KEYS.background] }}
            />
            {scheme.name}
          </button>
        ))}
      </div>
    </div>
  );
}

interface AppThemePickerProps {
  onClose?: () => void;
}

export function AppThemePicker({ onClose }: AppThemePickerProps = {}) {
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const customSchemes = useAppThemeStore((s) => s.customSchemes);
  const commitSchemeSelection = useAppThemeStore((s) => s.commitSchemeSelection);
  const addCustomScheme = useAppThemeStore((s) => s.addCustomScheme);
  const followSystem = useAppThemeStore((s) => s.followSystem);
  const setFollowSystem = useAppThemeStore((s) => s.setFollowSystem);
  const preferredDarkSchemeId = useAppThemeStore((s) => s.preferredDarkSchemeId);
  const setPreferredDarkSchemeId = useAppThemeStore((s) => s.setPreferredDarkSchemeId);
  const preferredLightSchemeId = useAppThemeStore((s) => s.preferredLightSchemeId);
  const setPreferredLightSchemeId = useAppThemeStore((s) => s.setPreferredLightSchemeId);
  const accentColorOverride = useAppThemeStore((s) => s.accentColorOverride);
  const setAccentColorOverride = useAppThemeStore((s) => s.setAccentColorOverride);
  const [importWarnings, setImportWarnings] = useState<AppThemeValidationWarning[]>([]);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const shuffleQueueRef = useRef<string[]>([]);

  const allSchemes = useMemo(() => [...BUILT_IN_APP_SCHEMES, ...customSchemes], [customSchemes]);
  const darkSchemes = useMemo(() => allSchemes.filter((s) => s.type !== "light"), [allSchemes]);
  const lightSchemes = useMemo(() => allSchemes.filter((s) => s.type === "light"), [allSchemes]);
  const selectedScheme = useMemo(
    () => allSchemes.find((s) => s.id === selectedSchemeId) ?? allSchemes[0]!,
    [allSchemes, selectedSchemeId]
  );

  const {
    imgRef: heroImgRef,
    error: heroError,
    onError: onHeroError,
  } = useImageError(selectedScheme.heroImage);

  const effectiveAccent = useMemo(
    () => accentColorOverride ?? selectedScheme.tokens["accent-primary"],
    [accentColorOverride, selectedScheme]
  );
  const pickerValue = useMemo(() => {
    const candidate = accentColorOverride ?? selectedScheme.tokens["accent-primary"];
    return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : "#000000";
  }, [accentColorOverride, selectedScheme]);

  // Warn — non-blocking — when an accent override drops below WCAG AA 4.5:1 against the
  // active theme, either as button-label text or as accent-tinted text on the theme surfaces.
  const accentContrastFail = useMemo(() => {
    if (!accentColorOverride) return false;
    return accentOverrideHasLowContrast(
      applyAccentOverrideToScheme(selectedScheme, accentColorOverride)
    );
  }, [accentColorOverride, selectedScheme]);

  const handleAccentInput = (e: FormEvent<HTMLInputElement>) => {
    setAccentColorOverride(e.currentTarget.value);
  };

  const handleAccentCommit = (e: ChangeEvent<HTMLInputElement>) => {
    setAccentColorOverride(e.target.value);
    appThemeClient.setAccentColorOverride(e.target.value).catch((error) => {
      logError("Failed to persist accent color override", error);
    });
  };

  const handleAccentReset = () => {
    setAccentColorOverride(null);
    appThemeClient.setAccentColorOverride(null).catch((error) => {
      logError("Failed to clear accent color override", error);
    });
  };

  const handleSelect = async (id: string, origin?: { x: number; y: number }) => {
    if (followSystem) {
      setFollowSystem(false);
      appThemeClient
        .setFollowSystem(false)
        .catch((err) => logError("Failed to clear follow system", err));
    }

    commitSchemeSelection(id);
    const scheme = resolveAppTheme(id, useAppThemeStore.getState().customSchemes);
    runThemeReveal(origin ?? null, () => injectSchemeToDOM(scheme, { immediate: true }));

    try {
      await appThemeClient.setColorScheme(id);
      await appThemeClient.setRecentSchemeIds(useAppThemeStore.getState().recentSchemeIds);
    } catch (error) {
      logError("Failed to persist app theme", error);
    }
  };

  const handleToggleFollowSystem = async () => {
    const newValue = !followSystem;
    setFollowSystem(newValue);
    try {
      await appThemeClient.setFollowSystem(newValue);
    } catch (error) {
      logError("Failed to persist follow system", error);
    }
  };

  const handlePreferredDarkChange = async (id: string) => {
    setPreferredDarkSchemeId(id);
    try {
      await appThemeClient.setPreferredDarkScheme(id);
    } catch (error) {
      logError("Failed to persist preferred dark scheme", error);
    }
  };

  const handlePreferredLightChange = async (id: string) => {
    setPreferredLightSchemeId(id);
    try {
      await appThemeClient.setPreferredLightScheme(id);
    } catch (error) {
      logError("Failed to persist preferred light scheme", error);
    }
  };

  // The import result block mounts after an async resolve, so screen-reader users
  // get no announcement from it appearing. Route the summary through the shared
  // announcer (AppDialog mounts AccessibilityAnnouncer in-subtree, handling the
  // Chromium aria-modal filter and document.ariaNotify).
  const announceImportResult = (message: string) => {
    setImportMessage(message);
    useAnnouncerStore.getState().announce(message);
  };

  const handleImport = async () => {
    setImportMessage(null);
    setImportWarnings([]);

    try {
      const result = await appThemeClient.importTheme();
      if (!result.ok) {
        if (!result.errors.includes("Import cancelled")) {
          announceImportResult(result.errors[0] ?? "Failed to import app theme.");
        }
        return;
      }

      addCustomScheme(result.scheme);
      await persistCustomSchemes();
      await handleSelect(result.scheme.id);

      if (result.warnings.length > 0) {
        setImportWarnings(result.warnings);
        // Count the deduplicated kind rows the user actually sees, not the raw
        // diagnostic count (those live under "Technical details") — otherwise
        // "12 warnings" next to 2 visible rows reads as missing content.
        const warningCount = groupWarningsByKind(result.warnings).length;
        announceImportResult(
          `Imported "${result.scheme.name}" with ${warningCount} warning${warningCount === 1 ? "" : "s"}.`
        );
      } else {
        announceImportResult(`Imported "${result.scheme.name}".`);
      }
    } catch (error) {
      logError("Failed to import app theme", error);
      announceImportResult("Failed to import app theme.");
    }
  };

  const handleExport = async () => {
    if (!selectedScheme) return;
    try {
      const effectiveScheme = applyAccentOverrideToScheme(selectedScheme, accentColorOverride);
      await appThemeClient.exportTheme(effectiveScheme);
    } catch (error) {
      logError("Failed to export app theme", error);
      announceImportResult("Failed to export app theme.");
    }
  };

  const handleShuffle = (e: MouseEvent) => {
    const otherIds = allSchemes.map((s) => s.id).filter((id) => id !== selectedSchemeId);
    if (otherIds.length === 0) return;

    shuffleQueueRef.current = shuffleQueueRef.current.filter((id) => id !== selectedSchemeId);

    if (shuffleQueueRef.current.length === 0) {
      shuffleQueueRef.current = shuffleArray(otherIds);
    }

    const nextId = shuffleQueueRef.current.shift()!;
    handleSelect(nextId, { x: e.clientX, y: e.clientY });
  };

  const handleChangeTheme = () => {
    window.dispatchEvent(new CustomEvent("daintree:open-theme-browser"));
  };

  return (
    <div className="space-y-3">
      <SettingsSwitchCard
        icon={Monitor}
        title="Match system appearance"
        subtitle="Automatically switch between dark and light themes"
        isEnabled={followSystem}
        onChange={handleToggleFollowSystem}
        ariaLabel="Toggle automatic theme switching"
        variant="compact"
      />

      {followSystem && (
        <div className="space-y-2 pl-1">
          <PreferredSchemePicker
            label="Preferred dark theme"
            schemes={darkSchemes}
            selectedId={preferredDarkSchemeId}
            onSelect={handlePreferredDarkChange}
          />
          <PreferredSchemePicker
            label="Preferred light theme"
            schemes={lightSchemes}
            selectedId={preferredLightSchemeId}
            onSelect={handlePreferredLightChange}
          />
        </div>
      )}

      {importMessage && (
        <div
          role="status"
          className="rounded-[var(--radius-md)] border border-overlay bg-surface-panel px-3 py-2"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle
              className={cn(
                "mt-0.5 h-3.5 w-3.5 shrink-0",
                importWarnings.length > 0 ? "text-status-warning" : "text-status-info"
              )}
            />
            <div className="min-w-0">
              <p className="text-xs text-daintree-text">{importMessage}</p>
              {importWarnings.length > 0 && (
                <ul className="mt-1 space-y-1.5">
                  {groupWarningsByKind(importWarnings).map(({ kind, messages }) => (
                    <li key={kind} className="text-[11px] text-daintree-text/60">
                      {WARNING_KIND_COPY[kind] ?? "Some theme values may need attention"}
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-daintree-text/40 transition-colors hover:text-daintree-text/70">
                          Technical details
                        </summary>
                        <ul className="mt-1 space-y-0.5 pl-3">
                          {messages.map((message, index) => (
                            <li key={index} className="break-words text-daintree-text/40">
                              {message}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col rounded-[var(--radius-md)] border border-daintree-border overflow-hidden">
        <div className="relative h-[200px] shrink-0 overflow-hidden">
          {selectedScheme.heroImage && !heroError ? (
            <img
              ref={heroImgRef}
              src={selectedScheme.heroImage}
              alt=""
              onError={onHeroError}
              className="w-full h-full object-cover"
            />
          ) : (
            <div
              className="w-full h-full flex items-center justify-center"
              style={{
                backgroundColor: selectedScheme.tokens[APP_THEME_PREVIEW_KEYS.background],
              }}
            >
              <PaletteStrip scheme={selectedScheme} />
            </div>
          )}
          {/* Media-overlay caption: sits on a guaranteed-dark scrim over the hero
              image, so the white label text is intentional and stays readable on
              every theme. `text-inverse` flips dark on dark themes — not usable here. */}
          <div className="absolute bottom-0 inset-x-0 bg-scrim-strong backdrop-blur-sm px-3 py-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
              {selectedScheme.name}
            </span>
            {selectedScheme.location && (
              <span className="text-[11px] text-white/75 drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
                {selectedScheme.location}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-daintree-border bg-daintree-bg">
          <span className="min-w-0 truncate text-xs text-daintree-text/60">Current theme</span>
          {onClose && (
            <Button variant="contrast" size="sm" onClick={handleChangeTheme} className="shrink-0">
              Change theme…
            </Button>
          )}
        </div>
      </div>

      <section
        aria-label="Accent color"
        className="flex items-center gap-3 p-2 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg"
      >
        <label
          htmlFor="accent-color-override-input"
          className="relative shrink-0 cursor-pointer"
          style={{ width: 32, height: 32 }}
        >
          <div
            className="w-full h-full rounded-md border border-daintree-border"
            style={{ backgroundColor: effectiveAccent }}
            aria-hidden="true"
          />
          <input
            id="accent-color-override-input"
            data-testid="accent-color-override-input"
            type="color"
            value={pickerValue}
            onInput={handleAccentInput}
            onChange={handleAccentCommit}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            aria-label="Accent color"
          />
        </label>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-daintree-text">Accent color</div>
          <div className="text-xs text-daintree-text/60">
            {accentColorOverride
              ? `Overriding theme accent (${effectiveAccent})`
              : "Click the swatch to override the theme accent"}
          </div>
        </div>
        {accentColorOverride && (
          <button
            type="button"
            onClick={handleAccentReset}
            data-testid="accent-color-override-reset"
            className="text-xs text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline transition-colors shrink-0"
          >
            Reset to theme default
          </button>
        )}
      </section>

      {accentContrastFail && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-[var(--radius-md)] border border-overlay bg-surface-panel px-3 py-2"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning" />
          <p className="min-w-0 text-xs text-daintree-text">
            Low contrast on {selectedScheme.name}
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleExport}
          className="text-xs text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline transition-colors"
        >
          Export app theme...
        </button>
        <button
          onClick={handleImport}
          className="text-xs text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline transition-colors"
        >
          Import app theme...
        </button>
        {allSchemes.length > 1 && (
          <button
            type="button"
            onClick={handleShuffle}
            className="ml-auto flex items-center gap-1.5 text-xs text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline transition-colors"
          >
            <Shuffle className="h-3 w-3" />
            Random theme
          </button>
        )}
      </div>
    </div>
  );
}
