import { useCallback, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { APP_THEME_PREVIEW_KEYS, getAppThemeWarnings } from "@shared/theme";
import type { AppColorScheme, AppThemeValidationWarning } from "@shared/types/appTheme";

function ThemePreview({ scheme }: { scheme: AppColorScheme }) {
  const t = scheme.tokens;
  return (
    <div
      className="rounded p-1.5"
      style={{ backgroundColor: t[APP_THEME_PREVIEW_KEYS.background] }}
    >
      <div className="flex gap-0.5">
        <div
          className="w-3 h-3 rounded-sm"
          style={{ backgroundColor: t[APP_THEME_PREVIEW_KEYS.sidebar] }}
        />
        <div className="flex-1 flex gap-0.5 flex-wrap">
          <div
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: t[APP_THEME_PREVIEW_KEYS.accent] }}
          />
          <div
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: t[APP_THEME_PREVIEW_KEYS.success] }}
          />
          <div
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: t[APP_THEME_PREVIEW_KEYS.warning] }}
          />
          <div
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: t[APP_THEME_PREVIEW_KEYS.danger] }}
          />
          <div
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: t[APP_THEME_PREVIEW_KEYS.text] }}
          />
          <div
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: t[APP_THEME_PREVIEW_KEYS.border] }}
          />
          <div
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: t[APP_THEME_PREVIEW_KEYS.panel] }}
          />
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
  const [importWarnings, setImportWarnings] = useState<AppThemeValidationWarning[]>([]);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const allSchemes = [...BUILT_IN_APP_SCHEMES, ...customSchemes];
  const warningsByScheme = useMemo(
    () => new Map(allSchemes.map((scheme) => [scheme.id, getAppThemeWarnings(scheme)])),
    [allSchemes]
  );

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

  return (
    <div className="space-y-3">
      {importMessage ? (
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
              {importWarnings.length > 0 ? (
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
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {allSchemes.map((scheme) => {
          const warnings = warningsByScheme.get(scheme.id) ?? [];
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
              <ThemePreview scheme={scheme} />
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs text-canopy-text truncate">{scheme.name}</span>
                {scheme.type === "light" && (
                  <span className="text-[10px] text-canopy-text/50 shrink-0">light</span>
                )}
                {warnings.length > 0 ? (
                  <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-status-warning/10 px-1.5 py-0.5 text-[10px] text-status-warning shrink-0">
                    <AlertTriangle className="h-3 w-3" />
                    {warnings.length}
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
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
