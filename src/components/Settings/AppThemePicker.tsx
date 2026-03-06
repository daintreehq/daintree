import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import type { AppColorScheme } from "@shared/types/appTheme";

function ThemePreview({ scheme }: { scheme: AppColorScheme }) {
  const t = scheme.tokens;
  return (
    <div className="rounded p-1.5" style={{ backgroundColor: t["canopy-bg"] }}>
      <div className="flex gap-0.5">
        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: t["canopy-sidebar"] }} />
        <div className="flex-1 flex gap-0.5 flex-wrap">
          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: t["canopy-accent"] }} />
          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: t["canopy-success"] }} />
          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: t["status-warning"] }} />
          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: t["status-error"] }} />
          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: t["canopy-text"] }} />
          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: t["canopy-border"] }} />
          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: t["surface"] }} />
        </div>
      </div>
    </div>
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

  const allSchemes = [...BUILT_IN_APP_SCHEMES, ...customSchemes];

  const handleSelect = useCallback(
    async (id: string) => {
      setSelectedSchemeId(id);
      try {
        await appThemeClient.setColorScheme(id);
      } catch (error) {
        console.error("Failed to persist app theme:", error);
      }
    },
    [setSelectedSchemeId]
  );

  const handleImport = useCallback(async () => {
    try {
      const result = await appThemeClient.importTheme();
      if (!result.ok) return;

      const imported = result.scheme;
      const scheme: AppColorScheme = {
        id: imported.id,
        name: imported.name,
        type: imported.type,
        builtin: false,
        tokens: imported.colors as unknown as AppColorScheme["tokens"],
      };
      addCustomScheme(scheme);
      setSelectedSchemeId(scheme.id);
      await appThemeClient.setColorScheme(scheme.id);
      await persistCustomSchemes();
    } catch (error) {
      console.error("Failed to import app theme:", error);
    }
  }, [addCustomScheme, setSelectedSchemeId]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {allSchemes.map((scheme) => (
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
            <ThemePreview scheme={scheme} />
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-canopy-text truncate">{scheme.name}</span>
              {scheme.type === "light" && (
                <span className="text-[10px] text-canopy-text/50 shrink-0">light</span>
              )}
            </div>
          </button>
        ))}
      </div>
      <button
        onClick={handleImport}
        className="text-xs text-canopy-accent hover:text-canopy-accent/80 transition-colors"
      >
        Import theme...
      </button>
    </div>
  );
}
