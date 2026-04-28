import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BUILT_IN_SCHEMES,
  DEFAULT_SCHEME_ID,
  getMappedTerminalScheme,
  type TerminalColorScheme,
} from "@/config/terminalColorSchemes";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { terminalConfigClient } from "@/clients/terminalConfigClient";
import { logError } from "@/utils/logger";

function SchemePreview({ scheme }: { scheme: TerminalColorScheme }) {
  const c = scheme.colors;
  const fg = c.foreground ?? "#ccc";

  return (
    <div
      className="rounded overflow-hidden"
      style={{
        backgroundColor: c.background ?? "#000",
        padding: "6px 8px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: "9px",
        lineHeight: "1.4",
        whiteSpace: "nowrap",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <div>
        <span style={{ color: c.green ?? fg }}>$ </span>
        <span style={{ color: fg }}>ls src/</span>
      </div>
      <div>
        <span style={{ color: c.cyan ?? fg }}>components/</span>
        <span style={{ color: fg }}> </span>
        <span style={{ color: c.cyan ?? fg }}>utils/</span>
        <span style={{ color: fg }}> index.ts</span>
      </div>
      <div>
        <span style={{ color: c.green ?? fg }}>$ </span>
        <span style={{ color: fg }}>git status</span>
      </div>
      <div>
        <span style={{ color: c.brightBlack ?? fg }}>modified: </span>
        <span style={{ color: c.yellow ?? fg }}>main.ts</span>
      </div>
      <div>
        <span style={{ color: c.green ?? fg }}>✓ </span>
        <span style={{ color: fg }}>3 tests passed</span>
      </div>
    </div>
  );
}

async function persistCustomSchemes() {
  const { customSchemes } = useTerminalColorSchemeStore.getState();
  await terminalConfigClient.setCustomSchemes(JSON.stringify(customSchemes));
}

function resolveSchemeForPreview(
  scheme: TerminalColorScheme,
  appThemeId: string
): TerminalColorScheme {
  if (scheme.id !== DEFAULT_SCHEME_ID) return scheme;
  const mapped = getMappedTerminalScheme(appThemeId);
  if (!mapped) return scheme;
  return { ...scheme, type: mapped.type, colors: mapped.colors };
}

export function ColorSchemePicker() {
  const selectedSchemeId = useTerminalColorSchemeStore((s) => s.selectedSchemeId);
  const customSchemes = useTerminalColorSchemeStore((s) => s.customSchemes);
  const setSelectedSchemeId = useTerminalColorSchemeStore((s) => s.setSelectedSchemeId);
  const setPreviewSchemeId = useTerminalColorSchemeStore((s) => s.setPreviewSchemeId);
  const addCustomScheme = useTerminalColorSchemeStore((s) => s.addCustomScheme);
  const appThemeId = useAppThemeStore((s) => s.selectedSchemeId);

  const [query, setQuery] = useState("");
  const [previewAnnouncement, setPreviewAnnouncement] = useState("");
  const [typeFilter, setTypeFilter] = useState<"dark" | "light">(() => {
    const all = [...BUILT_IN_SCHEMES, ...customSchemes];
    const selected = all.find((s) => s.id === selectedSchemeId);
    if (!selected) return "dark";
    const resolved = resolveSchemeForPreview(selected, appThemeId);
    return resolved.type === "light" ? "light" : "dark";
  });

  const revertRafRef = useRef<number | null>(null);

  const allSchemes = useMemo(() => [...BUILT_IN_SCHEMES, ...customSchemes], [customSchemes]);

  const lowerQuery = query.toLowerCase();
  const filteredSchemes = useMemo(() => {
    const byType = allSchemes.filter((s) => {
      const resolved = resolveSchemeForPreview(s, appThemeId);
      return typeFilter === "light" ? resolved.type === "light" : resolved.type !== "light";
    });
    if (!lowerQuery) return byType;
    return byType.filter((s) => s.name.toLowerCase().includes(lowerQuery));
  }, [allSchemes, typeFilter, lowerQuery, appThemeId]);

  const handlePreviewEnter = useCallback(
    (id: string) => {
      if (revertRafRef.current !== null) {
        cancelAnimationFrame(revertRafRef.current);
        revertRafRef.current = null;
      }
      setPreviewSchemeId(id);
      const scheme = allSchemes.find((s) => s.id === id);
      if (scheme) setPreviewAnnouncement(`Previewing: ${scheme.name}`);
    },
    [setPreviewSchemeId, allSchemes]
  );

  const handlePreviewLeave = useCallback(() => {
    if (revertRafRef.current !== null) {
      cancelAnimationFrame(revertRafRef.current);
    }
    revertRafRef.current = requestAnimationFrame(() => {
      revertRafRef.current = null;
      setPreviewSchemeId(null);
      setPreviewAnnouncement("");
    });
  }, [setPreviewSchemeId]);

  useEffect(() => {
    return () => {
      if (revertRafRef.current !== null) {
        cancelAnimationFrame(revertRafRef.current);
      }
      setPreviewSchemeId(null);
    };
  }, [setPreviewSchemeId]);

  const handleSelect = useCallback(
    async (id: string) => {
      setSelectedSchemeId(id);
      setPreviewSchemeId(null);
      try {
        await terminalConfigClient.setColorScheme(id);
        await terminalConfigClient.setRecentSchemeIds(
          useTerminalColorSchemeStore.getState().recentSchemeIds
        );
      } catch (error) {
        logError("Failed to persist color scheme", error);
      }
    },
    [setSelectedSchemeId, setPreviewSchemeId]
  );

  const handleImport = useCallback(async () => {
    try {
      const result = await terminalConfigClient.importColorScheme();
      if (!result.ok) return;

      const scheme: TerminalColorScheme = {
        ...result.scheme,
        builtin: false,
        colors: result.scheme.colors,
      };
      addCustomScheme(scheme);
      await persistCustomSchemes();
      await handleSelect(scheme.id);
    } catch (error) {
      logError("Failed to import color scheme", error);
    }
  }, [addCustomScheme, handleSelect]);

  const isEmpty = filteredSchemes.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-col rounded-[var(--radius-md)] border border-daintree-border overflow-hidden">
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
              placeholder="Filter schemes..."
              aria-label="Filter color schemes"
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
                  ? "bg-overlay-selected text-daintree-text"
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
                  ? "bg-overlay-selected text-daintree-text"
                  : "text-daintree-text/50 hover:text-daintree-text/70"
              )}
            >
              Light
            </button>
          </div>
        </div>

        <div
          className="max-h-[400px] overflow-y-auto p-2"
          role="listbox"
          aria-label="Color scheme list"
        >
          {isEmpty ? (
            <p className="text-xs text-daintree-text/50 text-center py-4">
              No schemes match your search.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {filteredSchemes.map((scheme) => {
                const resolved = resolveSchemeForPreview(scheme, appThemeId);
                const isSelected = scheme.id === selectedSchemeId;
                return (
                  <button
                    key={scheme.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(scheme.id)}
                    onPointerEnter={() => handlePreviewEnter(scheme.id)}
                    onPointerLeave={handlePreviewLeave}
                    onFocus={() => handlePreviewEnter(scheme.id)}
                    onBlur={handlePreviewLeave}
                    className={cn(
                      "flex flex-col gap-1.5 p-2 rounded-[var(--radius-md)] border transition-colors text-left",
                      "[&>*]:pointer-events-none",
                      isSelected
                        ? "border-border-strong bg-overlay-selected"
                        : "border-daintree-border bg-daintree-bg hover:border-daintree-text/30"
                    )}
                  >
                    <SchemePreview scheme={resolved} />
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-daintree-text truncate flex-1">
                        {scheme.name}
                      </span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-daintree-text shrink-0" />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {previewAnnouncement}
        </div>
      </div>

      <button
        onClick={handleImport}
        className="text-xs text-daintree-accent hover:text-daintree-accent/80 transition-colors"
      >
        Import color scheme...
      </button>
    </div>
  );
}
