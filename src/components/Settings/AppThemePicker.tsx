import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import { AlertCircle, AlertTriangle, Monitor, Shuffle } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { injectSchemeToDOM, useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { runThemeReveal } from "@/lib/appThemeViewTransition";
import {
  accentOverrideHasLowContrast,
  applyAccentOverrideToScheme,
  resolveAppTheme,
  type AccentContrastFailure,
} from "@shared/theme";
import { PaletteStrip } from "@/components/ui/PaletteStrip";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
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
      <p className="text-3xs font-medium uppercase tracking-wider text-text-secondary">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {schemes.map((scheme) => (
          <button
            key={scheme.id}
            type="button"
            onClick={() => onSelect(scheme.id)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-md)] border text-xs transition-colors",
              selectedId === scheme.id
                ? "border-border-strong bg-overlay-medium text-text-primary"
                : "border-border-default text-daintree-text/70 hover:bg-surface-hover"
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

type EpochKey = "scheme" | "accent" | "followSystem" | "preferredDark" | "preferredLight";

interface SaveError {
  domain: EpochKey;
  title: string;
  description: string;
  retry: () => void;
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
  const setRecentSchemeIds = useAppThemeStore((s) => s.setRecentSchemeIds);
  const recentSchemeIds = useAppThemeStore((s) => s.recentSchemeIds);
  const [importWarnings, setImportWarnings] = useState<AppThemeValidationWarning[]>([]);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<SaveError | null>(null);

  const shuffleQueueRef = useRef<string[]>([]);

  // What each field currently looks like on disk. Seeded from the hydrated store
  // on mount and advanced only as writes land, so a rollback restores durable
  // truth instead of an earlier optimistic value that never reached disk.
  //
  // The accent entry is why this is a ref and not a read of the store: the color
  // input previews through `setAccentColorOverride` on every `onInput` tick
  // without persisting, so by the time `onChange` commits, the store already
  // holds the new color and can no longer say what the old one was.
  //
  // It is deliberately NOT re-seeded from the store while mounted. The store is
  // not a truthful picture of disk — the accent preview writes to it without
  // persisting, and `app.setTheme` (appActions) applies a scheme optimistically
  // and leaves it applied even when its own save fails. Syncing from it would
  // record never-persisted values as durable. The cost is that a durable change
  // made elsewhere while this dialog sits open (an OS appearance switch) is not
  // picked up as the rollback baseline; reading it back from disk on failure
  // would be the fix if that ever bites.
  const confirmedRef = useRef({
    selectedSchemeId,
    recentSchemeIds,
    followSystem,
    preferredDarkSchemeId,
    preferredLightSchemeId,
    accentColorOverride,
  });

  // One counter per field. A rejection only reconciles the field if it is still
  // the newest write for it — otherwise a slow failure could drag a newer value
  // that did persist back to a stale one.
  const epochsRef = useRef<Record<EpochKey, number>>({
    scheme: 0,
    accent: 0,
    followSystem: 0,
    preferredDark: 0,
    preferredLight: 0,
  });

  // One banner at a time, but tagged with the field that raised it: an unrelated
  // field succeeding must not clear a failure the user hasn't dealt with.
  const clearErrorFor = (domain: EpochKey) =>
    setSaveError((current) => (current?.domain === domain ? null : current));

  // Optimistic write, then persist, then revert to the last value known to be on
  // disk if the write is rejected. `apply` goes through the store setters so the
  // rollback re-runs their DOM injection and the rendered theme matches what the
  // app will boot with.
  const persistSetting = async <T,>(
    domain: EpochKey,
    next: T,
    readConfirmed: () => T,
    writeConfirmed: (value: T) => void,
    apply: (value: T) => void,
    persist: (value: T) => Promise<void>,
    failure: { title: string; description: string }
  ): Promise<void> => {
    const epoch = ++epochsRef.current[domain];
    // A fresh intent for this field retires the banner its predecessor left, so a
    // stale Retry can't sit there waiting to resurrect a superseded value.
    clearErrorFor(domain);
    apply(next);

    try {
      await persist(next);
      writeConfirmed(next);
      if (epoch === epochsRef.current[domain]) clearErrorFor(domain);
    } catch (error) {
      logError(`Failed to persist app theme setting: ${domain}`, error);
      if (epoch !== epochsRef.current[domain]) return;
      apply(readConfirmed());
      setSaveError({
        ...failure,
        domain,
        retry: () =>
          void persistSetting(domain, next, readConfirmed, writeConfirmed, apply, persist, failure),
      });
    }
  };

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
  const accentContrastFail = useMemo<AccentContrastFailure | null>(() => {
    if (!accentColorOverride) return null;
    return accentOverrideHasLowContrast(
      applyAccentOverrideToScheme(selectedScheme, accentColorOverride)
    );
  }, [accentColorOverride, selectedScheme]);

  const handleAccentInput = (e: FormEvent<HTMLInputElement>) => {
    setAccentColorOverride(e.currentTarget.value);
  };

  const persistAccent = (color: string | null) =>
    persistSetting<string | null>(
      "accent",
      color,
      () => confirmedRef.current.accentColorOverride,
      (value) => (confirmedRef.current.accentColorOverride = value),
      setAccentColorOverride,
      (value) => appThemeClient.setAccentColorOverride(value),
      {
        title: "Couldn't save accent color",
        description: "The accent went back to the last saved color, so it won't change on restart.",
      }
    );

  const handleAccentCommit = (e: ChangeEvent<HTMLInputElement>) => {
    void persistAccent(e.target.value);
  };

  const handleAccentReset = () => {
    void persistAccent(null);
  };

  // Three independently durable writes: turning system matching off, saving the
  // scheme, then saving the MRU list. They are not atomic, so each confirmed
  // value advances as its own write lands and the rollback restores every field
  // to whatever is actually on disk — a scheme that failed after system matching
  // was already turned off reverts the theme without turning matching back on.
  const handleSelect = async (id: string, origin?: { x: number; y: number }) => {
    const epoch = ++epochsRef.current.scheme;
    clearErrorFor("scheme");

    // Read live rather than closing over the render's value: Retry re-invokes an
    // older render's handleSelect, and a stale `followSystem` there would either
    // skip the turn-off or leave the store showing matching that is really off.
    const storeFollowSystem = useAppThemeStore.getState().followSystem;
    // Write the turn-off if EITHER source says matching is on: disk may still
    // have it on (an in-flight toggle-off could yet fail), or the store may have
    // it on with a toggle-on in flight. The write is idempotent, and issuing it
    // last is what guarantees disk ends with matching off — otherwise the app
    // boots following the system and overrides the very theme being saved.
    const mustDisableFollowSystem = confirmedRef.current.followSystem || storeFollowSystem;
    // Claim the follow-system field, so a toggle racing this selection cannot
    // reconcile it behind our back, and so we reconcile it only while we own it.
    const followEpoch = mustDisableFollowSystem ? ++epochsRef.current.followSystem : null;
    const ownsScheme = () => epoch === epochsRef.current.scheme;
    const ownsFollowSystem = () =>
      followEpoch !== null && followEpoch === epochsRef.current.followSystem;

    if (storeFollowSystem) setFollowSystem(false);
    commitSchemeSelection(id);
    const targetRecents = useAppThemeStore.getState().recentSchemeIds;
    const scheme = resolveAppTheme(id, useAppThemeStore.getState().customSchemes);
    runThemeReveal(origin ?? null, () => injectSchemeToDOM(scheme, { immediate: true }));

    const restoreConfirmed = () => {
      const confirmed = confirmedRef.current;
      // Only put system matching back if this selection is what turned it off.
      // Otherwise a newer toggle the user made while this write was in flight
      // would be silently undone.
      if (ownsFollowSystem()) setFollowSystem(confirmed.followSystem);
      // commitSchemeSelection re-seeds the MRU as a side effect, so the recents
      // list has to be put back after it, not before.
      commitSchemeSelection(confirmed.selectedSchemeId);
      setRecentSchemeIds(confirmed.recentSchemeIds);
      injectSchemeToDOM(
        resolveAppTheme(confirmed.selectedSchemeId, useAppThemeStore.getState().customSchemes),
        { immediate: true }
      );
    };

    try {
      if (mustDisableFollowSystem) {
        await appThemeClient.setFollowSystem(false);
        confirmedRef.current.followSystem = false;
        // Matching is now off on disk, so a banner an earlier failed toggle left
        // behind is describing a state that no longer exists.
        clearErrorFor("followSystem");
      }
      // A newer selection may have overtaken us while we awaited. Sending the
      // scheme now would land on disk AFTER the newer one and leave the app
      // booting into a theme the UI never showed — bail instead. Whatever we
      // already wrote stays written and stays reflected in confirmedRef.
      if (!ownsScheme()) return;

      await appThemeClient.setColorScheme(id);
      confirmedRef.current.selectedSchemeId = id;
    } catch (error) {
      logError("Failed to persist app theme", error);
      if (!ownsScheme()) return;
      restoreConfirmed();
      setSaveError({
        domain: "scheme",
        title: "Couldn't save theme",
        description: "The previous theme was restored, so it won't change on restart.",
        retry: () => void handleSelect(id),
      });
      return;
    }

    if (!ownsScheme()) return;
    clearErrorFor("scheme");

    // The MRU list drives the theme browser's "recent" row and is invisible from
    // here, so a failure to save it gives the user nothing to see and nothing to
    // act on. Keep memory matching disk and log it rather than raising a banner
    // over a theme change that did save.
    try {
      await appThemeClient.setRecentSchemeIds(targetRecents);
      confirmedRef.current.recentSchemeIds = targetRecents;
    } catch (error) {
      logError("Failed to persist recent app themes", error);
      if (ownsScheme()) setRecentSchemeIds(confirmedRef.current.recentSchemeIds);
    }
  };

  const handleToggleFollowSystem = () =>
    persistSetting<boolean>(
      "followSystem",
      !followSystem,
      () => confirmedRef.current.followSystem,
      (value) => (confirmedRef.current.followSystem = value),
      setFollowSystem,
      (value) => appThemeClient.setFollowSystem(value),
      {
        title: "Couldn't save appearance setting",
        description:
          "System appearance matching went back to its last saved state, so it won't change on restart.",
      }
    );

  const handlePreferredDarkChange = (id: string) =>
    persistSetting<string>(
      "preferredDark",
      id,
      () => confirmedRef.current.preferredDarkSchemeId,
      (value) => (confirmedRef.current.preferredDarkSchemeId = value),
      setPreferredDarkSchemeId,
      (value) => appThemeClient.setPreferredDarkScheme(value),
      {
        title: "Couldn't save preferred dark theme",
        description: "The previous dark theme was restored, so it won't change on restart.",
      }
    );

  const handlePreferredLightChange = (id: string) =>
    persistSetting<string>(
      "preferredLight",
      id,
      () => confirmedRef.current.preferredLightSchemeId,
      (value) => (confirmedRef.current.preferredLightSchemeId = value),
      setPreferredLightSchemeId,
      (value) => appThemeClient.setPreferredLightScheme(value),
      {
        title: "Couldn't save preferred light theme",
        description: "The previous light theme was restored, so it won't change on restart.",
      }
    );

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
      {saveError && (
        <InlineStatusBanner
          className="rounded-[var(--radius-md)]"
          severity="error"
          icon={AlertCircle}
          title={saveError.title}
          description={saveError.description}
          action={{ id: "retry", label: "Retry", onClick: saveError.retry }}
          onClose={() => setSaveError(null)}
          closeAriaLabel="Dismiss theme error"
        />
      )}

      <SettingsSwitchCard
        icon={Monitor}
        title="Match system appearance"
        subtitle="Automatically switch between dark and light themes"
        isEnabled={followSystem}
        onChange={() => void handleToggleFollowSystem()}
        ariaLabel="Toggle automatic theme switching"
        variant="compact"
      />

      {followSystem && (
        <div className="space-y-2 pl-1">
          <PreferredSchemePicker
            label="Preferred dark theme"
            schemes={darkSchemes}
            selectedId={preferredDarkSchemeId}
            onSelect={(id) => void handlePreferredDarkChange(id)}
          />
          <PreferredSchemePicker
            label="Preferred light theme"
            schemes={lightSchemes}
            selectedId={preferredLightSchemeId}
            onSelect={(id) => void handlePreferredLightChange(id)}
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
              <p className="text-xs text-text-primary">{importMessage}</p>
              {importWarnings.length > 0 && (
                <ul className="mt-1 space-y-1.5">
                  {groupWarningsByKind(importWarnings).map(({ kind, messages }) => (
                    <li key={kind} className="text-2xs text-daintree-text/60">
                      {WARNING_KIND_COPY[kind] ?? "Some theme values may need attention"}
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-daintree-text/40 transition-colors hover:text-daintree-text/70">
                          Technical details
                        </summary>
                        <ul className="mt-1 space-y-0.5 pl-3">
                          {messages.map((message, index) => (
                            <li key={index} className="break-words text-text-secondary">
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

      <div className="flex flex-col rounded-[var(--radius-md)] border border-border-default overflow-hidden">
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
              <span className="text-2xs text-white/75 drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
                {selectedScheme.location}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border-default bg-surface-canvas">
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
        className="flex items-center gap-3 p-2 rounded-[var(--radius-md)] border border-border-default bg-surface-canvas"
      >
        <label
          htmlFor="accent-color-override-input"
          className="relative shrink-0 cursor-pointer"
          style={{ width: 32, height: 32 }}
        >
          <div
            className="w-full h-full rounded-md border border-border-default"
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
          <div className="text-sm font-medium text-text-primary">Accent color</div>
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
            className="text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline transition-colors shrink-0"
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
          <p className="min-w-0 text-xs text-text-primary">
            {accentContrastFail.mode === "foreground"
              ? `Low contrast: button text scores only ${accentContrastFail.worstRatio.toFixed(2)}:1 on the accent color — pick a lighter or darker accent`
              : `Low contrast: the accent scores only ${accentContrastFail.worstRatio.toFixed(2)}:1 on ${selectedScheme.name} surfaces — pick a more distinct accent`}
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleExport}
          className="text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline transition-colors"
        >
          Export app theme...
        </button>
        <button
          onClick={handleImport}
          className="text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline transition-colors"
        >
          Import app theme...
        </button>
        {allSchemes.length > 1 && (
          <button
            type="button"
            onClick={handleShuffle}
            className="ml-auto flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline transition-colors"
          >
            <Shuffle className="h-3 w-3" />
            Random theme
          </button>
        )}
      </div>
    </div>
  );
}
