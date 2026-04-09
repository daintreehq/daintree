import { useCallback, useMemo } from "react";
import {
  BUILT_IN_SCHEMES,
  DEFAULT_SCHEME_ID,
  getMappedTerminalScheme,
  type TerminalColorScheme,
} from "@/config/terminalColorSchemes";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { terminalConfigClient } from "@/clients/terminalConfigClient";
import { ThemeSelector } from "./ThemeSelector";

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
  const addCustomScheme = useTerminalColorSchemeStore((s) => s.addCustomScheme);
  const recentSchemeIds = useTerminalColorSchemeStore((s) => s.recentSchemeIds);
  const appThemeId = useAppThemeStore((s) => s.selectedSchemeId);

  const allSchemes = useMemo(() => [...BUILT_IN_SCHEMES, ...customSchemes], [customSchemes]);
  const recentSchemes = useMemo(
    () =>
      recentSchemeIds
        .map((id) => allSchemes.find((s) => s.id === id))
        .filter((s): s is TerminalColorScheme => Boolean(s)),
    [recentSchemeIds, allSchemes]
  );
  const recentIdSet = useMemo(() => new Set(recentSchemes.map((s) => s.id)), [recentSchemes]);
  const otherSchemes = useMemo(
    () => allSchemes.filter((s) => !recentIdSet.has(s.id)),
    [allSchemes, recentIdSet]
  );

  const handleSelect = useCallback(
    async (id: string) => {
      setSelectedSchemeId(id);
      try {
        await terminalConfigClient.setColorScheme(id);
        await terminalConfigClient.setRecentSchemeIds(
          useTerminalColorSchemeStore.getState().recentSchemeIds
        );
      } catch (error) {
        console.error("Failed to persist color scheme:", error);
      }
    },
    [setSelectedSchemeId]
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
      console.error("Failed to import color scheme:", error);
    }
  }, [addCustomScheme, handleSelect]);

  return (
    <div className="space-y-3">
      {recentSchemes.length > 0 ? (
        <ThemeSelector<TerminalColorScheme>
          groups={[
            { label: "Recently Used", items: recentSchemes },
            ...(otherSchemes.length > 0 ? [{ label: "All schemes", items: otherSchemes }] : []),
          ]}
          selectedId={selectedSchemeId}
          onSelect={handleSelect}
          renderPreview={(scheme) => (
            <SchemePreview scheme={resolveSchemeForPreview(scheme, appThemeId)} />
          )}
          renderMeta={(scheme) => {
            const resolved = resolveSchemeForPreview(scheme, appThemeId);
            return (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-canopy-text truncate">{scheme.name}</span>
                {resolved.type === "light" && (
                  <span className="text-[10px] text-canopy-text/50 shrink-0">light</span>
                )}
              </div>
            );
          }}
          getName={(s) => s.name}
        />
      ) : (
        <ThemeSelector<TerminalColorScheme>
          items={allSchemes}
          selectedId={selectedSchemeId}
          onSelect={handleSelect}
          renderPreview={(scheme) => (
            <SchemePreview scheme={resolveSchemeForPreview(scheme, appThemeId)} />
          )}
          renderMeta={(scheme) => {
            const resolved = resolveSchemeForPreview(scheme, appThemeId);
            return (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-canopy-text truncate">{scheme.name}</span>
                {resolved.type === "light" && (
                  <span className="text-[10px] text-canopy-text/50 shrink-0">light</span>
                )}
              </div>
            );
          }}
          getName={(s) => s.name}
        />
      )}
      <button
        onClick={handleImport}
        className="text-xs text-canopy-accent hover:text-canopy-accent/80 transition-colors"
      >
        Import color scheme...
      </button>
    </div>
  );
}
