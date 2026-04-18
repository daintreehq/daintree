import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import { AlertTriangle, Check, Monitor, Search, Shuffle } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { injectSchemeToDOM, useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { runThemeReveal } from "@/lib/appThemeViewTransition";
import { applyAccentOverrideToScheme, resolveAppTheme } from "@shared/theme";
import { PaletteStrip } from "@/components/ui/PaletteStrip";
import { APP_THEME_PREVIEW_KEYS, getAppThemeWarnings } from "@shared/theme";
import type { AppColorScheme, AppThemeValidationWarning } from "@shared/types/appTheme";
import { SettingsSwitchCard } from "./SettingsSwitchCard";

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
  await appThemeClient.setCustomSchemes(JSON.stringify(customSchemes));
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
                ? "border-daintree-accent/30 bg-daintree-accent/10 text-daintree-text"
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

function ThemeRow({
  scheme,
  isSelected,
  onSelect,
  warnings,
}: {
  scheme: AppColorScheme;
  isSelected: boolean;
  onSelect: (id: string, origin: { x: number; y: number }) => void;
  warnings: AppThemeValidationWarning[];
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      onClick={(e) => onSelect(scheme.id, { x: e.clientX, y: e.clientY })}
      className={cn(
        "w-full flex items-center gap-2.5 px-2.5 py-2 text-left transition-colors",
        isSelected ? "bg-daintree-accent/10" : "hover:bg-surface-hover"
      )}
    >
      {scheme.heroImage ? (
        <img
          src={scheme.heroImage.replace("/themes/", "/themes/thumb/")}
          alt=""
          width={80}
          height={80}
          loading="lazy"
          className="w-10 h-10 rounded-sm shrink-0 object-cover"
        />
      ) : (
        <div
          className="w-10 h-10 rounded-sm shrink-0 border border-daintree-border/50"
          style={{ backgroundColor: scheme.tokens[APP_THEME_PREVIEW_KEYS.background] }}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-daintree-text truncate">{scheme.name}</span>
          {warnings.length > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-status-warning/10 px-1.5 py-0.5 text-[10px] text-status-warning shrink-0">
              <AlertTriangle className="h-2.5 w-2.5" />
              {warnings.length}
            </span>
          )}
        </div>
        {scheme.location && (
          <span className="text-[11px] text-daintree-text/40 truncate block">
            {scheme.location}
          </span>
        )}
      </div>
      <PaletteStrip scheme={scheme} />
      <div className="w-4 shrink-0 flex items-center justify-center">
        {isSelected && <Check className="w-3.5 h-3.5 text-daintree-accent" />}
      </div>
    </button>
  );
}

export function AppThemePicker() {
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
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"dark" | "light">(() =>
    (selectedSchemeId &&
      [...BUILT_IN_APP_SCHEMES, ...customSchemes].find((s) => s.id === selectedSchemeId)?.type) ===
    "light"
      ? "light"
      : "dark"
  );

  const shuffleQueueRef = useRef<string[]>([]);

  const allSchemes = useMemo(() => [...BUILT_IN_APP_SCHEMES, ...customSchemes], [customSchemes]);
  const darkSchemes = useMemo(() => allSchemes.filter((s) => s.type !== "light"), [allSchemes]);
  const lightSchemes = useMemo(() => allSchemes.filter((s) => s.type === "light"), [allSchemes]);
  const selectedScheme = useMemo(
    () => allSchemes.find((s) => s.id === selectedSchemeId) ?? allSchemes[0]!,
    [allSchemes, selectedSchemeId]
  );

  const lowerQuery = query.toLowerCase();
  const filteredThemes = useMemo(() => {
    const byType = typeFilter === "light" ? lightSchemes : darkSchemes;
    if (!lowerQuery) return byType;
    return byType.filter((s) => s.name.toLowerCase().includes(lowerQuery));
  }, [darkSchemes, lightSchemes, typeFilter, lowerQuery]);

  const warningsByScheme = useMemo(
    () =>
      new Map(
        allSchemes.map((scheme) => [
          scheme.id,
          getAppThemeWarnings(applyAccentOverrideToScheme(scheme, accentColorOverride)),
        ])
      ),
    [allSchemes, accentColorOverride]
  );

  const effectiveAccent = useMemo(
    () => accentColorOverride ?? selectedScheme.tokens["accent-primary"],
    [accentColorOverride, selectedScheme]
  );
  const pickerValue = useMemo(() => {
    const candidate = accentColorOverride ?? selectedScheme.tokens["accent-primary"];
    return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : "#000000";
  }, [accentColorOverride, selectedScheme]);

  const handleAccentInput = useCallback(
    (e: FormEvent<HTMLInputElement>) => {
      setAccentColorOverride(e.currentTarget.value);
    },
    [setAccentColorOverride]
  );

  const handleAccentCommit = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setAccentColorOverride(e.target.value);
      appThemeClient.setAccentColorOverride(e.target.value).catch((error) => {
        console.error("Failed to persist accent color override:", error);
      });
    },
    [setAccentColorOverride]
  );

  const handleAccentReset = useCallback(() => {
    setAccentColorOverride(null);
    appThemeClient.setAccentColorOverride(null).catch((error) => {
      console.error("Failed to clear accent color override:", error);
    });
  }, [setAccentColorOverride]);

  const handleSelect = useCallback(
    async (id: string, origin?: { x: number; y: number }) => {
      if (followSystem) {
        setFollowSystem(false);
        appThemeClient.setFollowSystem(false).catch(console.error);
      }

      const scheme = resolveAppTheme(id, useAppThemeStore.getState().customSchemes);
      commitSchemeSelection(id);
      setTypeFilter(scheme.type === "light" ? "light" : "dark");
      runThemeReveal(origin ?? null, () => injectSchemeToDOM(scheme));

      try {
        await appThemeClient.setColorScheme(id);
        await appThemeClient.setRecentSchemeIds(useAppThemeStore.getState().recentSchemeIds);
      } catch (error) {
        console.error("Failed to persist app theme:", error);
      }
    },
    [commitSchemeSelection, followSystem, setFollowSystem]
  );

  const handleToggleFollowSystem = useCallback(async () => {
    const newValue = !followSystem;
    setFollowSystem(newValue);
    try {
      await appThemeClient.setFollowSystem(newValue);
    } catch (error) {
      console.error("Failed to persist follow system:", error);
    }
  }, [followSystem, setFollowSystem]);

  const handlePreferredDarkChange = useCallback(
    async (id: string) => {
      setPreferredDarkSchemeId(id);
      try {
        await appThemeClient.setPreferredDarkScheme(id);
      } catch (error) {
        console.error("Failed to persist preferred dark scheme:", error);
      }
    },
    [setPreferredDarkSchemeId]
  );

  const handlePreferredLightChange = useCallback(
    async (id: string) => {
      setPreferredLightSchemeId(id);
      try {
        await appThemeClient.setPreferredLightScheme(id);
      } catch (error) {
        console.error("Failed to persist preferred light scheme:", error);
      }
    },
    [setPreferredLightSchemeId]
  );

  const handleImport = useCallback(async () => {
    setImportMessage(null);
    setImportWarnings([]);

    try {
      const result = await appThemeClient.importTheme();
      if (!result.ok) {
        if (!result.errors.includes("Import cancelled")) {
          setImportMessage(result.errors[0] ?? "Failed to import app theme.");
        }
        return;
      }

      addCustomScheme(result.scheme);
      await persistCustomSchemes();
      await handleSelect(result.scheme.id);

      if (result.warnings.length > 0) {
        setImportWarnings(result.warnings);
        setImportMessage(
          `Imported "${result.scheme.name}" with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}.`
        );
      } else {
        setImportMessage(`Imported "${result.scheme.name}".`);
      }
    } catch (error) {
      console.error("Failed to import app theme:", error);
      setImportMessage("Failed to import app theme.");
    }
  }, [addCustomScheme, handleSelect]);

  const handleExport = useCallback(async () => {
    if (!selectedScheme) return;
    try {
      const effectiveScheme = applyAccentOverrideToScheme(selectedScheme, accentColorOverride);
      await appThemeClient.exportTheme(effectiveScheme);
    } catch (error) {
      console.error("Failed to export app theme:", error);
      setImportMessage("Failed to export app theme.");
    }
  }, [selectedScheme, accentColorOverride]);

  const handleShuffle = useCallback(
    (e: MouseEvent) => {
      const otherIds = allSchemes.map((s) => s.id).filter((id) => id !== selectedSchemeId);
      if (otherIds.length === 0) return;

      shuffleQueueRef.current = shuffleQueueRef.current.filter((id) => id !== selectedSchemeId);

      if (shuffleQueueRef.current.length === 0) {
        shuffleQueueRef.current = shuffleArray(otherIds);
      }

      const nextId = shuffleQueueRef.current.shift()!;
      handleSelect(nextId, { x: e.clientX, y: e.clientY });
    },
    [allSchemes, selectedSchemeId, handleSelect]
  );

  const isEmpty = filteredThemes.length === 0;

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
        <div className="rounded-[var(--radius-md)] border border-overlay bg-surface-panel px-3 py-2">
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
                <ul className="mt-1 space-y-1">
                  {importWarnings.map((warning, index) => (
                    <li
                      key={`${warning.message}-${index}`}
                      className="text-[11px] text-daintree-text/60"
                    >
                      {warning.message}
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
          {selectedScheme.heroImage ? (
            <img
              src={selectedScheme.heroImage}
              alt={selectedScheme.name}
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
          <div className="absolute bottom-0 inset-x-0 bg-black/40 backdrop-blur-sm px-3 py-1.5 flex items-center justify-between">
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

        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-daintree-border shrink-0">
          <div className="flex items-center gap-1.5 flex-1 min-w-0 focus-within:border-daintree-accent">
            <Search className="w-3.5 h-3.5 shrink-0 text-daintree-text/40 pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="Filter themes..."
              aria-label="Filter themes"
              className="flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder:text-daintree-text/40 focus:outline-none"
            />
          </div>
          <div className="flex rounded-[var(--radius-md)] border border-daintree-border overflow-hidden shrink-0">
            <button
              type="button"
              onClick={() => setTypeFilter("dark")}
              className={cn(
                "px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                typeFilter === "dark"
                  ? "bg-daintree-accent/15 text-daintree-text"
                  : "text-daintree-text/50 hover:text-daintree-text/70"
              )}
            >
              Dark
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter("light")}
              className={cn(
                "px-2.5 py-0.5 text-[11px] font-medium transition-colors border-l border-daintree-border",
                typeFilter === "light"
                  ? "bg-daintree-accent/15 text-daintree-text"
                  : "text-daintree-text/50 hover:text-daintree-text/70"
              )}
            >
              Light
            </button>
          </div>
        </div>

        <div role="listbox" aria-label="Theme list">
          {isEmpty ? (
            <p className="text-xs text-daintree-text/50 text-center py-4">
              No themes match your search.
            </p>
          ) : (
            filteredThemes.map((scheme) => (
              <ThemeRow
                key={scheme.id}
                scheme={scheme}
                isSelected={scheme.id === selectedSchemeId}
                onSelect={handleSelect}
                warnings={warningsByScheme.get(scheme.id) ?? []}
              />
            ))
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
            className="text-xs text-daintree-accent hover:text-daintree-accent/80 transition-colors shrink-0"
          >
            Reset to theme default
          </button>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={handleExport}
          className="text-xs text-daintree-accent hover:text-daintree-accent/80 transition-colors"
        >
          Export app theme...
        </button>
        <button
          onClick={handleImport}
          className="text-xs text-daintree-accent hover:text-daintree-accent/80 transition-colors"
        >
          Import app theme...
        </button>
        {allSchemes.length > 1 && (
          <button
            type="button"
            onClick={handleShuffle}
            className="ml-auto flex items-center gap-1.5 text-xs text-daintree-accent hover:text-daintree-accent/80 transition-colors"
          >
            <Shuffle className="h-3 w-3" />
            Random theme
          </button>
        )}
      </div>
    </div>
  );
}
