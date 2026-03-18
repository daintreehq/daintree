import { useCallback } from "react";
import { Palette } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { APP_THEME_PREVIEW_KEYS } from "@shared/theme";
import type { AppColorScheme } from "@shared/types/appTheme";

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

const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light");
const lightSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type === "light");

interface ThemeSelectionStepProps {
  isOpen: boolean;
  onContinue: () => void;
  onSkip: () => void;
}

export function ThemeSelectionStep({ isOpen, onContinue, onSkip }: ThemeSelectionStepProps) {
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const setSelectedSchemeId = useAppThemeStore((s) => s.setSelectedSchemeId);

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

  return (
    <AppDialog isOpen={isOpen} onClose={onSkip} size="md" dismissible>
      <AppDialog.Header>
        <AppDialog.Title icon={<Palette className="w-5 h-5 text-canopy-accent" />}>
          Choose your theme
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <div className="space-y-4">
          <p className="text-sm text-canopy-text/60">
            Pick a color theme for your workspace. You can change this anytime from{" "}
            <span className="text-canopy-text/80">Settings → Appearance</span>.
          </p>

          {darkSchemes.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-canopy-text/40 select-none">
                Dark
              </p>
              <div className="grid grid-cols-3 gap-2">
                {darkSchemes.map((scheme) => (
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
                    <span className="text-xs text-canopy-text truncate">{scheme.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {lightSchemes.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-canopy-text/40 select-none">
                Light
              </p>
              <div className="grid grid-cols-3 gap-2">
                {lightSchemes.map((scheme) => (
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
                    <span className="text-xs text-canopy-text truncate">{scheme.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onSkip} className="text-canopy-text/60 mr-auto">
          Skip
        </Button>
        <Button onClick={onContinue}>Continue</Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
