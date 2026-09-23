import {
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import { AlertCircle, Shuffle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
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
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
} from "./SettingsGroup";
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

/** One casing for every hex on the row: the picker reports lowercase, themes uppercase. */
function formatHex(color: string | undefined): string {
  return (color ?? "").toUpperCase();
}

async function persistCustomSchemes() {
  const { customSchemes } = useAppThemeStore.getState();
  await appThemeClient.setCustomSchemes(customSchemes);
}

/**
 * A theme as a chip: its canvas with its accent set in it. Canvas alone told the dark
 * themes apart from nothing — they are all near-black. The frame is text-secondary so
 * the chip keeps a 3:1 edge on either card.
 */
function ThemeSwatch({ scheme }: { scheme: AppColorScheme }) {
  return (
    <span
      className="inline-flex w-3.5 h-3.5 shrink-0 items-center justify-center rounded-sm border border-text-secondary"
      style={{ backgroundColor: scheme.tokens[APP_THEME_PREVIEW_KEYS.background] }}
      aria-hidden="true"
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: scheme.tokens["accent-primary"] }}
      />
    </span>
  );
}

function PreferredSchemeRow({
  label,
  schemes,
  selectedId,
  defaultId,
  onSelect,
}: {
  label: string;
  schemes: AppColorScheme[];
  selectedId: string;
  defaultId: string;
  onSelect: (id: string) => void;
}) {
  const defaultName = schemes.find((s) => s.id === defaultId)?.name ?? defaultId;
  return (
    <SettingsRow
      label={label}
      description={`Default: ${defaultName}`}
      isModified={selectedId !== defaultId}
      onReset={() => onSelect(defaultId)}
      control={({ labelId, descriptionId, disabled }) => (
        <Select value={selectedId} onValueChange={onSelect} disabled={disabled}>
          <SelectTrigger
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            className={SETTINGS_CONTROL_WIDTH.select}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {schemes.map((scheme) => (
              <SelectItem key={scheme.id} value={scheme.id}>
                <span className="flex items-center gap-2">
                  <ThemeSwatch scheme={scheme} />
                  {scheme.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    />
  );
}

const DEFAULT_PREFERRED_DARK = "daintree";
const DEFAULT_PREFERRED_LIGHT = "bondi";

interface AppThemePickerProps {
  onClose?: () => void;
}

type EpochKey = "scheme" | "accent" | "followSystem" | "preferredDark" | "preferredLight";

type FileResult =
  | { kind: "imported"; message: string; warnings: AppThemeValidationWarning[] }
  | { kind: "error"; title: string; description: string; retry: () => void };

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
  const [fileResult, setFileResult] = useState<FileResult | null>(null);
  const [saveError, setSaveError] = useState<SaveError | null>(null);

  const shuffleQueueRef = useRef<string[]>([]);
  const accentWarningId = useId();

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

  // Results mount after an async resolve, so screen-reader users get no announcement
  // from them appearing. Route the summary through the shared announcer (AppDialog
  // mounts AccessibilityAnnouncer in-subtree, handling the Chromium aria-modal filter
  // and document.ariaNotify).
  const showFileResult = (result: FileResult) => {
    setFileResult(result);
    useAnnouncerStore
      .getState()
      .announce(result.kind === "error" ? result.description : result.message);
  };

  const handleImport = async () => {
    setFileResult(null);

    try {
      const result = await appThemeClient.importTheme();
      if (!result.ok) {
        if (!result.errors.includes("Import cancelled")) {
          showFileResult({
            kind: "error",
            title: "Couldn't import theme",
            description: result.errors[0] ?? "The file isn't a theme Daintree can read.",
            retry: () => void handleImport(),
          });
        }
        return;
      }

      addCustomScheme(result.scheme);
      await persistCustomSchemes();
      await handleSelect(result.scheme.id);

      // Count the deduplicated kind rows the user actually sees, not the raw
      // diagnostic count (those live under "Technical details") — otherwise
      // "12 warnings" next to 2 visible rows reads as missing content.
      const warningCount = groupWarningsByKind(result.warnings).length;
      showFileResult({
        kind: "imported",
        warnings: result.warnings,
        message:
          warningCount > 0
            ? `Imported "${result.scheme.name}" with ${warningCount} warning${warningCount === 1 ? "" : "s"}.`
            : `Imported "${result.scheme.name}".`,
      });
    } catch (error) {
      logError("Failed to import app theme", error);
      showFileResult({
        kind: "error",
        title: "Couldn't import theme",
        description: "Something went wrong reading the file.",
        retry: () => void handleImport(),
      });
    }
  };

  const handleExport = async () => {
    if (!selectedScheme) return;
    setFileResult(null);
    try {
      const effectiveScheme = applyAccentOverrideToScheme(selectedScheme, accentColorOverride);
      await appThemeClient.exportTheme(effectiveScheme);
    } catch (error) {
      logError("Failed to export app theme", error);
      showFileResult({
        kind: "error",
        title: "Couldn't export theme",
        description: "The theme file wasn't written.",
        retry: () => void handleExport(),
      });
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
    void handleSelect(nextId, { x: e.clientX, y: e.clientY });
  };

  const handleChangeTheme = () => {
    window.dispatchEvent(new CustomEvent("daintree:open-theme-browser"));
  };

  const themeDefaultAccent = selectedScheme.tokens["accent-primary"];
  const defaultSchemeName =
    allSchemes.find((scheme) => scheme.id === DEFAULT_APP_SCHEME_ID)?.name ?? "the default";

  return (
    <SettingsGroup>
      {/* The theme's place is the hero of this group rather than a card of its own, so
          the theme, how it follows the OS, and how it is tuned read as one surface. */}
      <div className="relative h-[200px] overflow-hidden rounded-t-[var(--radius-lg)]">
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
        <div className="absolute bottom-0 inset-x-0 bg-scrim-strong backdrop-blur-sm px-4 py-1.5 flex items-center justify-between gap-4">
          <span className="text-sm font-medium text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
            {selectedScheme.name}
          </span>
          {selectedScheme.location && (
            <span className="min-w-0 truncate text-2xs text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
              {selectedScheme.location}
            </span>
          )}
        </div>
      </div>

      <SettingsRow
        label="Theme"
        description={
          followSystem
            ? "Picking a theme turns off system matching"
            : `${allSchemes.length} themes to browse, each with a live preview`
        }
        isModified={!followSystem && selectedSchemeId !== DEFAULT_APP_SCHEME_ID}
        onReset={() => void handleSelect(DEFAULT_APP_SCHEME_ID)}
        resetAriaLabel={`Reset app theme to ${defaultSchemeName}`}
        control={
          <>
            {allSchemes.length > 1 && (
              <Button variant="outline" size="sm" onClick={handleShuffle}>
                <Shuffle aria-hidden="true" />
                Random theme
              </Button>
            )}
            {onClose && (
              <Button variant="contrast" size="sm" onClick={handleChangeTheme}>
                Change theme…
              </Button>
            )}
          </>
        }
      />

      <SettingsSwitchCard
        title="Match system appearance"
        subtitle="Switches between a dark and a light theme when your OS appearance changes"
        isEnabled={followSystem}
        onChange={() => void handleToggleFollowSystem()}
        isModified={followSystem}
        onReset={() => void handleToggleFollowSystem()}
      />
      <SettingsDependents
        disabled={!followSystem}
        reason="Used while Match system appearance is on"
      >
        <PreferredSchemeRow
          label="Dark theme"
          schemes={darkSchemes}
          selectedId={preferredDarkSchemeId}
          defaultId={DEFAULT_PREFERRED_DARK}
          onSelect={(id) => void handlePreferredDarkChange(id)}
        />
        <PreferredSchemeRow
          label="Light theme"
          schemes={lightSchemes}
          selectedId={preferredLightSchemeId}
          defaultId={DEFAULT_PREFERRED_LIGHT}
          onSelect={(id) => void handlePreferredLightChange(id)}
        />
      </SettingsDependents>

      <SettingsRow
        label="Accent color"
        isModified={!!accentColorOverride}
        onReset={handleAccentReset}
        resetAriaLabel="Reset accent color to the theme's"
        description={
          accentColorOverride
            ? `${formatHex(effectiveAccent)} · Theme default: ${formatHex(themeDefaultAccent)}`
            : `The theme's own, ${formatHex(themeDefaultAccent)}. Pick a color to override it.`
        }
        control={({ labelId, descriptionId }) => (
          <label
            htmlFor="accent-color-override-input"
            className={cn(
              "relative block w-8 h-8 shrink-0 cursor-pointer rounded-[var(--radius-md)]",
              // The input is invisible, so its focus has to show on the well it sits in.
              "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2",
              "has-[input:focus-visible]:outline-accent-primary has-[input:focus-visible]:outline-offset-2"
            )}
          >
            {/* A colour well: the text-secondary frame keeps an edge at 3:1 whatever
                colour fills it, including an override that matches the card. */}
            <span
              className="block w-full h-full rounded-[var(--radius-md)] border border-text-secondary"
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
              aria-labelledby={labelId}
              aria-describedby={
                [descriptionId, accentContrastFail ? accentWarningId : null]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            />
          </label>
        )}
      />
      {accentContrastFail && (
        <div className="px-4 py-3" id={accentWarningId}>
          <InlineStatusBanner
            className="rounded-[var(--radius-md)]"
            severity="warning"
            role="status"
            title="Low contrast accent"
            description={
              accentContrastFail.mode === "foreground"
                ? `Button text scores ${accentContrastFail.worstRatio.toFixed(2)}:1 on this accent. Pick a lighter or darker one.`
                : `The accent scores ${accentContrastFail.worstRatio.toFixed(2)}:1 on ${selectedScheme.name} surfaces. Pick a more distinct one.`
            }
          />
        </div>
      )}

      <SettingsRow
        label="Theme files"
        description="Load a theme from a file, or save this one to share it"
        control={({ disabled }) => (
          <>
            <Button variant="outline" size="sm" onClick={handleImport} disabled={disabled}>
              Import…
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={disabled}>
              Export…
            </Button>
          </>
        )}
      />

      {fileResult?.kind === "error" && (
        <div className="px-4 py-3">
          <InlineStatusBanner
            className="rounded-[var(--radius-md)]"
            severity="error"
            icon={AlertCircle}
            title={fileResult.title}
            description={fileResult.description}
            action={{ id: "retry", label: "Retry", onClick: fileResult.retry }}
            onClose={() => setFileResult(null)}
            closeAriaLabel="Dismiss theme file error"
          />
        </div>
      )}
      {fileResult?.kind === "imported" && (
        <div className="px-4 py-3">
          <InlineStatusBanner
            className="rounded-[var(--radius-md)]"
            severity={fileResult.warnings.length > 0 ? "warning" : "info"}
            role="status"
            title={fileResult.message}
            onClose={() => setFileResult(null)}
            closeAriaLabel="Dismiss import result"
            descriptionExtras={
              fileResult.warnings.length > 0 ? (
                <ul className="mt-1 space-y-1.5">
                  {groupWarningsByKind(fileResult.warnings).map(({ kind, messages }) => (
                    <li key={kind} className="text-xs text-text-secondary">
                      {WARNING_KIND_COPY[kind] ?? "Some theme values may need attention"}
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-text-secondary transition-colors hover:text-text-primary">
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
              ) : undefined
            }
          />
        </div>
      )}

      {saveError && (
        <div className="px-4 py-3">
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
        </div>
      )}
    </SettingsGroup>
  );
}
