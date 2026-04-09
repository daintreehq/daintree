import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { AlertTriangle, Monitor, Palette, Shuffle } from "lucide-react";
import { ThemeSelector } from "./ThemeSelector";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { injectSchemeToDOM, useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { prefersReducedMotion, runThemeReveal } from "@/lib/appThemeViewTransition";
import { resolveAppTheme } from "@shared/theme";
import { AppDialog } from "@/components/ui/AppDialog";
import { PaletteStrip } from "@/components/ui/PaletteStrip";
import { APP_THEME_PREVIEW_KEYS, getAppThemeWarnings } from "@shared/theme";
import type { AppColorScheme, AppThemeValidationWarning } from "@shared/types/appTheme";
import { SettingsSwitchCard } from "./SettingsSwitchCard";

function HeroImage({ scheme, size }: { scheme: AppColorScheme; size: number }) {
  if (scheme.heroImage?.trim()) {
    return (
      <img
        src={scheme.heroImage}
        alt={scheme.name}
        width={size}
        height={size}
        loading="lazy"
        className="rounded-lg object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="rounded-lg flex items-center justify-center"
      style={{
        width: size,
        height: size,
        backgroundColor: scheme.tokens[APP_THEME_PREVIEW_KEYS.background],
      }}
    >
      <PaletteStrip scheme={scheme} />
    </div>
  );
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
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
      <p className="text-[10px] font-medium uppercase tracking-wider text-canopy-text/40">
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
                ? "border-canopy-accent/30 bg-canopy-accent/10 text-canopy-text"
                : "border-canopy-border text-canopy-text/70 hover:bg-surface-hover"
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

export function AppThemePicker() {
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const customSchemes = useAppThemeStore((s) => s.customSchemes);
  const commitSchemeSelection = useAppThemeStore((s) => s.commitSchemeSelection);
  const injectTheme = useAppThemeStore((s) => s.injectTheme);
  const addCustomScheme = useAppThemeStore((s) => s.addCustomScheme);
  const recentSchemeIds = useAppThemeStore((s) => s.recentSchemeIds);
  const followSystem = useAppThemeStore((s) => s.followSystem);
  const setFollowSystem = useAppThemeStore((s) => s.setFollowSystem);
  const preferredDarkSchemeId = useAppThemeStore((s) => s.preferredDarkSchemeId);
  const setPreferredDarkSchemeId = useAppThemeStore((s) => s.setPreferredDarkSchemeId);
  const preferredLightSchemeId = useAppThemeStore((s) => s.preferredLightSchemeId);
  const setPreferredLightSchemeId = useAppThemeStore((s) => s.setPreferredLightSchemeId);
  const [importWarnings, setImportWarnings] = useState<AppThemeValidationWarning[]>([]);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [previewAnnouncement, setPreviewAnnouncement] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoGenRef = useRef(0);
  const shuffleQueueRef = useRef<string[]>([]);

  const allSchemes = useMemo(() => [...BUILT_IN_APP_SCHEMES, ...customSchemes], [customSchemes]);
  const recentSchemes = useMemo(
    () =>
      recentSchemeIds
        .map((id) => allSchemes.find((s) => s.id === id))
        .filter((s): s is AppColorScheme => Boolean(s)),
    [recentSchemeIds, allSchemes]
  );
  const recentIdSet = useMemo(() => new Set(recentSchemes.map((s) => s.id)), [recentSchemes]);
  const darkSchemes = useMemo(
    () => allSchemes.filter((s) => s.type !== "light" && !recentIdSet.has(s.id)),
    [allSchemes, recentIdSet]
  );
  const lightSchemes = useMemo(
    () => allSchemes.filter((s) => s.type === "light" && !recentIdSet.has(s.id)),
    [allSchemes, recentIdSet]
  );
  // Unfiltered dark/light lists — used for follow-system preferred pickers that
  // should not hide recently-used themes.
  const allDarkSchemes = useMemo(() => allSchemes.filter((s) => s.type !== "light"), [allSchemes]);
  const allLightSchemes = useMemo(() => allSchemes.filter((s) => s.type === "light"), [allSchemes]);
  const selectedScheme = useMemo(
    () => allSchemes.find((s) => s.id === selectedSchemeId) ?? allSchemes[0],
    [allSchemes, selectedSchemeId]
  );

  const warningsByScheme = useMemo(
    () => new Map(allSchemes.map((scheme) => [scheme.id, getAppThemeWarnings(scheme)])),
    [allSchemes]
  );

  const handleSelect = useCallback(
    async (id: string, origin?: { x: number; y: number }) => {
      const prev = selectedSchemeId;

      if (followSystem) {
        setFollowSystem(false);
        appThemeClient.setFollowSystem(false).catch(console.error);
      }

      // Resolve against a fresh store read — `customSchemes` from the
      // component closure can be stale when `handleImport` calls
      // `handleSelect` synchronously right after `addCustomScheme`.
      const scheme = resolveAppTheme(id, useAppThemeStore.getState().customSchemes);
      commitSchemeSelection(id);
      runThemeReveal(origin ?? null, () => injectSchemeToDOM(scheme));
      // Modal stays open during live preview so the user can keep browsing.

      try {
        await appThemeClient.setColorScheme(id);
        // Only persist the updated recents once the selection itself was saved.
        // Read back from the store so we capture the post-LRU-update state.
        await appThemeClient.setRecentSchemeIds(useAppThemeStore.getState().recentSchemeIds);
      } catch (error) {
        console.error("Failed to persist app theme:", error);
      }

      if (scheme.heroVideo && id !== prev && !prefersReducedMotion()) {
        const gen = ++videoGenRef.current;
        const video = videoRef.current;
        if (video) {
          video.src = scheme.heroVideo;
          video.load();
          video.oncanplaythrough = () => {
            if (videoGenRef.current !== gen) return;
            video.style.opacity = "1";
            video.play().catch(() => {});
          };
          video.onended = () => {
            if (videoGenRef.current !== gen) return;
            video.style.opacity = "0";
          };
        }
      }
    },
    [commitSchemeSelection, selectedSchemeId, followSystem, setFollowSystem]
  );

  const handleOpen = useCallback(() => {
    setPreviewAnnouncement("");
    setOpen(true);
  }, []);

  const handleModalClose = useCallback(() => {
    // On close, ensure the DOM reflects the currently committed selection.
    // If the user only hovered (no click), the store's selectedSchemeId is
    // unchanged and this reverts the ephemeral preview. If the user clicked
    // to commit, the store already holds the new selection so this is a
    // no-op visually but keeps store and DOM in lockstep regardless.
    const committed = allSchemes.find((s) => s.id === selectedSchemeId);
    if (committed) {
      injectTheme(committed);
    }
    setPreviewAnnouncement("");
    setOpen(false);
  }, [allSchemes, injectTheme, selectedSchemeId]);

  const handlePreviewItem = useCallback(
    (id: string) => {
      const scheme = allSchemes.find((s) => s.id === id);
      if (!scheme) return;
      injectTheme(scheme);
      setPreviewAnnouncement(`Previewing: ${scheme.name}`);
    },
    [allSchemes, injectTheme]
  );

  const handlePreviewEnd = useCallback(() => {
    const committed = allSchemes.find((s) => s.id === selectedSchemeId);
    if (committed) {
      injectTheme(committed);
    }
    setPreviewAnnouncement("");
  }, [allSchemes, selectedSchemeId, injectTheme]);

  // If the picker unmounts mid-preview (e.g. the parent settings view
  // switches tabs without closing the theme modal first), make sure the DOM
  // is snapped back to whatever the store currently says is committed so we
  // do not leak a preview into the app chrome.
  useEffect(() => {
    return () => {
      const committedId = useAppThemeStore.getState().selectedSchemeId;
      const { customSchemes: storeCustomSchemes } = useAppThemeStore.getState();
      const pool = [...BUILT_IN_APP_SCHEMES, ...storeCustomSchemes];
      const committed = pool.find((s) => s.id === committedId);
      if (committed) {
        useAppThemeStore.getState().injectTheme(committed);
      }
    };
  }, []);

  const handleShuffle = useCallback(
    (e: MouseEvent) => {
      const otherIds = allSchemes.map((s) => s.id).filter((id) => id !== selectedSchemeId);
      if (otherIds.length === 0) return;

      // Filter out current theme in case it was manually selected mid-cycle
      shuffleQueueRef.current = shuffleQueueRef.current.filter((id) => id !== selectedSchemeId);

      if (shuffleQueueRef.current.length === 0) {
        shuffleQueueRef.current = shuffleArray(otherIds);
      }

      const nextId = shuffleQueueRef.current.shift()!;
      handleSelect(nextId, { x: e.clientX, y: e.clientY });
    },
    [allSchemes, selectedSchemeId, handleSelect]
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
      await appThemeClient.exportTheme(selectedScheme);
    } catch (error) {
      console.error("Failed to export app theme:", error);
      setImportMessage("Failed to export app theme.");
    }
  }, [selectedScheme]);

  const selectedWarnings = warningsByScheme.get(selectedScheme.id) ?? [];

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
            schemes={allDarkSchemes}
            selectedId={preferredDarkSchemeId}
            onSelect={handlePreferredDarkChange}
          />
          <PreferredSchemePicker
            label="Preferred light theme"
            schemes={allLightSchemes}
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
              <p className="text-xs text-canopy-text">{importMessage}</p>
              {importWarnings.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {importWarnings.map((warning, index) => (
                    <li
                      key={`${warning.message}-${index}`}
                      className="text-[11px] text-canopy-text/60"
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

      <button
        type="button"
        data-testid="theme-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={handleOpen}
        className={cn(
          "w-full flex items-center gap-3 p-2 rounded-[var(--radius-md)] border transition-colors text-left",
          "border-canopy-border bg-canopy-bg hover:border-canopy-text/30"
        )}
      >
        <div className="relative shrink-0">
          <HeroImage scheme={selectedScheme} size={96} />
          {selectedScheme.heroVideo && (
            <video
              ref={videoRef}
              muted
              playsInline
              preload="none"
              className="absolute inset-0 w-full h-full rounded-lg object-cover transition-opacity duration-500"
              style={{ opacity: 0 }}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-canopy-text truncate">
              {selectedScheme.name}
            </span>
            {selectedWarnings.length > 0 && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-status-warning/10 px-1.5 py-0.5 text-[10px] text-status-warning shrink-0">
                <AlertTriangle className="h-2.5 w-2.5" />
                {selectedWarnings.length}
              </span>
            )}
          </div>
          {selectedScheme.location && (
            <span className="text-xs text-canopy-text/50 truncate block">
              {selectedScheme.location}
            </span>
          )}
          <div className="mt-1.5">
            <PaletteStrip scheme={selectedScheme} />
          </div>
        </div>
      </button>

      <AppDialog
        isOpen={open}
        onClose={handleModalClose}
        size="xl"
        data-testid="theme-picker-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title icon={<Palette className="h-5 w-5" />}>Choose a theme</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.BodyScroll>
          <ThemeSelector<AppColorScheme>
            groups={[
              ...(recentSchemes.length > 0
                ? [{ label: "Recently Used", items: recentSchemes }]
                : []),
              ...(darkSchemes.length > 0 ? [{ label: "Dark", items: darkSchemes }] : []),
              ...(lightSchemes.length > 0 ? [{ label: "Light", items: lightSchemes }] : []),
            ]}
            selectedId={selectedSchemeId}
            onSelect={handleSelect}
            onPreviewItem={handlePreviewItem}
            onPreviewEnd={handlePreviewEnd}
            previewAnnouncement={previewAnnouncement}
            columns={3}
            renderPreview={(scheme) => <HeroImage scheme={scheme} size={130} />}
            renderMeta={(scheme) => {
              const warnings = warningsByScheme.get(scheme.id) ?? [];
              return (
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-canopy-text truncate">
                      {scheme.name}
                    </span>
                    {warnings.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-status-warning/10 px-1.5 py-0.5 text-[10px] text-status-warning shrink-0">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        {warnings.length}
                      </span>
                    )}
                  </div>
                  {scheme.location && (
                    <span className="text-[11px] text-canopy-text/50 truncate block">
                      {scheme.location}
                    </span>
                  )}
                  <div className="mt-1">
                    <PaletteStrip scheme={scheme} />
                  </div>
                </div>
              );
            }}
            getName={(s) => s.name}
          />
        </AppDialog.BodyScroll>
      </AppDialog>

      <div className="flex items-center gap-3">
        <button
          onClick={handleExport}
          className="text-xs text-canopy-accent hover:text-canopy-accent/80 transition-colors"
        >
          Export app theme...
        </button>
        <button
          onClick={handleImport}
          className="text-xs text-canopy-accent hover:text-canopy-accent/80 transition-colors"
        >
          Import app theme...
        </button>
        {allSchemes.length > 1 && (
          <button
            type="button"
            onClick={handleShuffle}
            className="ml-auto flex items-center gap-1.5 text-xs text-canopy-accent hover:text-canopy-accent/80 transition-colors"
          >
            <Shuffle className="h-3 w-3" />
            Random theme
          </button>
        )}
      </div>
    </div>
  );
}
