import { useCallback } from "react";
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

  const allSchemes = [...BUILT_IN_SCHEMES, ...customSchemes];

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
      <button
        onClick={handleImport}
        className="text-xs text-canopy-accent hover:text-canopy-accent/80 transition-colors"
      >
        Import color scheme...
      </button>
    </div>
  );
}
