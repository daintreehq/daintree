import { useCallback, useMemo, useState } from "react";
import { Search } from "lucide-react";
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

function SchemePreview({ scheme }: { scheme: TerminalColorScheme }) {
  const colors = scheme.colors;
  const swatchColors = [
    colors.black,
    colors.red,
    colors.green,
    colors.yellow,
    colors.blue,
    colors.magenta,
    colors.cyan,
    colors.white,
    colors.brightBlack,
    colors.brightRed,
    colors.brightGreen,
    colors.brightYellow,
    colors.brightBlue,
    colors.brightMagenta,
    colors.brightCyan,
    colors.brightWhite,
  ];

  return (
    <div className="rounded p-1.5" style={{ backgroundColor: colors.background ?? "#000" }}>
      <div className="grid grid-cols-8 gap-0.5">
        {swatchColors.map((color, i) => (
          <div
            key={i}
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: color ?? "#888" }}
          />
        ))}
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
  const appThemeId = useAppThemeStore((s) => s.selectedSchemeId);

  const [filterQuery, setFilterQuery] = useState("");
  const allSchemes = useMemo(() => [...BUILT_IN_SCHEMES, ...customSchemes], [customSchemes]);
  const filteredSchemes = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return q ? allSchemes.filter((s) => s.name.toLowerCase().includes(q)) : allSchemes;
  }, [allSchemes, filterQuery]);

  const handleSelect = useCallback(
    async (id: string) => {
      setSelectedSchemeId(id);
      try {
        await terminalConfigClient.setColorScheme(id);
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
      setSelectedSchemeId(scheme.id);
      await terminalConfigClient.setColorScheme(scheme.id);
      await persistCustomSchemes();
    } catch (error) {
      console.error("Failed to import color scheme:", error);
    }
  }, [addCustomScheme, setSelectedSchemeId]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <Search size={14} className="shrink-0 text-canopy-text/40" aria-hidden="true" />
        <input
          type="text"
          placeholder="Filter schemes…"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          className="flex-1 min-w-0 text-xs bg-transparent text-canopy-text placeholder:text-canopy-text/40 focus:outline-none border-b border-canopy-border pb-1"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {filteredSchemes.map((scheme) => {
          const resolved = resolveSchemeForPreview(scheme, appThemeId);
          return (
            <button
              key={scheme.id}
              onClick={() => handleSelect(scheme.id)}
              className={cn(
                "flex flex-col gap-1.5 p-2 rounded-[var(--radius-md)] border transition-colors text-left",
                selectedSchemeId === scheme.id
                  ? "border-canopy-accent bg-canopy-accent/10"
                  : "border-canopy-border bg-canopy-bg hover:border-canopy-text/30"
              )}
            >
              <SchemePreview scheme={resolved} />
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-canopy-text truncate">{scheme.name}</span>
                {resolved.type === "light" && (
                  <span className="text-[10px] text-canopy-text/50 shrink-0">light</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {filteredSchemes.length === 0 && filterQuery && (
        <div className="px-2 py-3 text-xs text-canopy-text/40 text-center">
          No schemes match &ldquo;{filterQuery}&rdquo;
        </div>
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
