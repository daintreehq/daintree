import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { APP_THEME_PREVIEW_KEYS, getAppThemeWarnings } from "@shared/theme";
import type { AppColorScheme, AppThemeValidationWarning } from "@shared/types/appTheme";

function PaletteStrip({ scheme }: { scheme: AppColorScheme }) {
  const t = scheme.tokens;
  const keys = [
    APP_THEME_PREVIEW_KEYS.accent,
    APP_THEME_PREVIEW_KEYS.success,
    APP_THEME_PREVIEW_KEYS.warning,
    APP_THEME_PREVIEW_KEYS.danger,
    APP_THEME_PREVIEW_KEYS.text,
    APP_THEME_PREVIEW_KEYS.border,
    APP_THEME_PREVIEW_KEYS.panel,
    APP_THEME_PREVIEW_KEYS.sidebar,
  ] as const;
  return (
    <div className="flex gap-0.5">
      {keys.map((key) => (
        <div
          key={key}
          className="w-3 h-3 rounded-sm shrink-0"
          style={{ backgroundColor: t[key] }}
        />
      ))}
    </div>
  );
}

function HeroImage({ scheme, size }: { scheme: AppColorScheme; size: number }) {
  if (scheme.heroImage) {
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

function ThemeOption({
  scheme,
  selected,
  highlighted,
  warnings,
  onClick,
  id,
}: {
  scheme: AppColorScheme;
  selected: boolean;
  highlighted: boolean;
  warnings: AppThemeValidationWarning[];
  onClick: () => void;
  id: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted) {
      ref.current?.scrollIntoView({ block: "nearest" });
    }
  }, [highlighted]);

  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-2 py-1.5 cursor-pointer rounded-[var(--radius-md)] transition-colors",
        highlighted && "bg-canopy-accent/10",
        selected && "bg-canopy-accent/15 border border-canopy-accent/30",
        !selected && "border border-transparent",
        !highlighted && !selected && "hover:bg-surface-hover"
      )}
    >
      <HeroImage scheme={scheme} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-canopy-text truncate">{scheme.name}</span>
          {warnings.length > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-status-warning/10 px-1.5 py-0.5 text-[10px] text-status-warning shrink-0">
              <AlertTriangle className="h-2.5 w-2.5" />
              {warnings.length}
            </span>
          )}
        </div>
        {scheme.location && (
          <span className="text-[11px] text-canopy-text/50 truncate block">{scheme.location}</span>
        )}
      </div>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.body.dataset.performanceMode === "true"
  );
}

async function persistCustomSchemes() {
  const { customSchemes } = useAppThemeStore.getState();
  await appThemeClient.setCustomSchemes(JSON.stringify(customSchemes));
}

export function AppThemePicker() {
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const customSchemes = useAppThemeStore((s) => s.customSchemes);
  const setSelectedSchemeId = useAppThemeStore((s) => s.setSelectedSchemeId);
  const addCustomScheme = useAppThemeStore((s) => s.addCustomScheme);
  const [importWarnings, setImportWarnings] = useState<AppThemeValidationWarning[]>([]);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoGenRef = useRef(0);

  const allSchemes = useMemo(() => [...BUILT_IN_APP_SCHEMES, ...customSchemes], [customSchemes]);
  const darkSchemes = useMemo(() => allSchemes.filter((s) => s.type !== "light"), [allSchemes]);
  const lightSchemes = useMemo(() => allSchemes.filter((s) => s.type === "light"), [allSchemes]);
  const flatList = useMemo(() => [...darkSchemes, ...lightSchemes], [darkSchemes, lightSchemes]);

  const selectedScheme = useMemo(
    () => allSchemes.find((s) => s.id === selectedSchemeId) ?? allSchemes[0],
    [allSchemes, selectedSchemeId]
  );

  const warningsByScheme = useMemo(
    () => new Map(allSchemes.map((scheme) => [scheme.id, getAppThemeWarnings(scheme)])),
    [allSchemes]
  );

  const handleSelect = useCallback(
    async (id: string) => {
      const prev = selectedSchemeId;
      setSelectedSchemeId(id);
      setOpen(false);
      setActiveIndex(-1);

      try {
        await appThemeClient.setColorScheme(id);
      } catch (error) {
        console.error("Failed to persist app theme:", error);
      }

      const scheme = allSchemes.find((s) => s.id === id);
      if (scheme?.heroVideo && id !== prev && !prefersReducedMotion()) {
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
    [setSelectedSchemeId, selectedSchemeId, allSchemes]
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
      setSelectedSchemeId(result.scheme.id);
      await appThemeClient.setColorScheme(result.scheme.id);
      await persistCustomSchemes();

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
  }, [addCustomScheme, setSelectedSchemeId]);

  useEscapeStack(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        listRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(true);
          const idx = flatList.findIndex((s) => s.id === selectedSchemeId);
          setActiveIndex(idx >= 0 ? idx : 0);
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((prev) => (prev < flatList.length - 1 ? prev + 1 : prev));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case "Home":
          e.preventDefault();
          setActiveIndex(0);
          break;
        case "End":
          e.preventDefault();
          setActiveIndex(flatList.length - 1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < flatList.length) {
            handleSelect(flatList[activeIndex].id);
          }
          break;
      }
    },
    [open, flatList, activeIndex, selectedSchemeId, handleSelect]
  );

  const activeDescendant =
    open && activeIndex >= 0 ? `theme-option-${flatList[activeIndex]?.id}` : undefined;

  const selectedWarnings = warningsByScheme.get(selectedScheme.id) ?? [];

  let darkIdx = 0;

  return (
    <div className="space-y-3">
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

      <div className="relative">
        <button
          ref={triggerRef}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls="theme-listbox"
          aria-activedescendant={activeDescendant}
          onClick={() => {
            setOpen((v) => !v);
            if (!open) {
              const idx = flatList.findIndex((s) => s.id === selectedSchemeId);
              setActiveIndex(idx >= 0 ? idx : 0);
            }
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            "w-full flex items-center gap-3 p-2 rounded-[var(--radius-md)] border transition-colors text-left",
            "border-canopy-border bg-canopy-bg hover:border-canopy-text/30",
            open && "border-canopy-accent"
          )}
        >
          <div className="relative shrink-0">
            <HeroImage scheme={selectedScheme} size={64} />
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
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-canopy-text/40 transition-transform",
              open && "rotate-180"
            )}
          />
        </button>

        {open && (
          <div
            ref={listRef}
            id="theme-listbox"
            role="listbox"
            aria-label="Theme list"
            className="absolute z-50 left-0 right-0 mt-1 max-h-[280px] overflow-y-auto rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg shadow-lg"
          >
            {darkSchemes.length > 0 && (
              <>
                <div className="sticky top-0 bg-canopy-bg/90 backdrop-blur-sm px-2 py-1 z-10">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-canopy-text/40 select-none">
                    Dark
                  </p>
                </div>
                {darkSchemes.map((scheme) => {
                  const idx = darkIdx++;
                  return (
                    <ThemeOption
                      key={scheme.id}
                      id={`theme-option-${scheme.id}`}
                      scheme={scheme}
                      selected={selectedSchemeId === scheme.id}
                      highlighted={activeIndex === idx}
                      warnings={warningsByScheme.get(scheme.id) ?? []}
                      onClick={() => handleSelect(scheme.id)}
                    />
                  );
                })}
              </>
            )}
            {lightSchemes.length > 0 && (
              <>
                <div className="sticky top-0 bg-canopy-bg/90 backdrop-blur-sm px-2 py-1 z-10">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-canopy-text/40 select-none">
                    Light
                  </p>
                </div>
                {lightSchemes.map((scheme, i) => (
                  <ThemeOption
                    key={scheme.id}
                    id={`theme-option-${scheme.id}`}
                    scheme={scheme}
                    selected={selectedSchemeId === scheme.id}
                    highlighted={activeIndex === darkSchemes.length + i}
                    warnings={warningsByScheme.get(scheme.id) ?? []}
                    onClick={() => handleSelect(scheme.id)}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <button
        onClick={handleImport}
        className="text-xs text-canopy-accent hover:text-canopy-accent/80 transition-colors"
      >
        Import app theme...
      </button>
    </div>
  );
}
