import { useCallback, useEffect, useRef } from "react";
import { Check, Palette, Sun, Moon } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import type { AppColorScheme } from "@shared/types/appTheme";

const daintreeScheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
const bondiScheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === "bondi")!;

function ThemeMockup({ scheme }: { scheme: AppColorScheme }) {
  const t = scheme.tokens;
  return (
    <div
      className="rounded-lg overflow-hidden border"
      style={{ backgroundColor: t["surface-canvas"], borderColor: t["border-default"] }}
    >
      {/* Title bar */}
      <div
        className="flex items-center gap-1 px-2 py-1"
        style={{
          backgroundColor: t["surface-panel-elevated"],
          borderBottom: `1px solid ${t["border-default"]}`,
        }}
      >
        <div className="flex gap-1">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: t["status-danger"] }}
          />
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: t["status-warning"] }}
          />
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: t["status-success"] }}
          />
        </div>
        <div className="flex-1" />
        <div className="text-[6px] font-medium tracking-wide" style={{ color: t["text-muted"] }}>
          Canopy
        </div>
        <div className="flex-1" />
      </div>

      <div className="flex" style={{ height: 100 }}>
        {/* Sidebar */}
        <div
          className="flex flex-col items-center gap-1.5 py-2 px-1"
          style={{
            backgroundColor: t["surface-sidebar"],
            borderRight: `1px solid ${t["border-default"]}`,
            width: 24,
          }}
        >
          <div
            className="w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: t["accent-primary"] }}
          />
          <div
            className="w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: t["text-muted"], opacity: 0.5 }}
          />
          <div
            className="w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: t["text-muted"], opacity: 0.5 }}
          />
        </div>

        {/* Main area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tab bar */}
          <div
            className="flex items-center"
            style={{ borderBottom: `1px solid ${t["border-default"]}` }}
          >
            <div
              className="px-2 py-0.5 text-[6px]"
              style={{
                backgroundColor: t["surface-panel"],
                color: t["text-primary"],
                borderBottom: `1.5px solid ${t["accent-primary"]}`,
              }}
            >
              main.ts
            </div>
            <div
              className="px-2 py-0.5 text-[6px]"
              style={{
                backgroundColor: t["surface-canvas"],
                color: t["text-muted"],
              }}
            >
              config.ts
            </div>
          </div>

          {/* Editor area */}
          <div
            className="flex-1 px-2 py-1.5 font-mono text-[7px] leading-[11px] space-y-px overflow-hidden"
            style={{ backgroundColor: t["surface-panel"] }}
          >
            <div>
              <span style={{ color: t["syntax-keyword"] }}>import</span>
              <span style={{ color: t["syntax-punctuation"] }}>{" { "}</span>
              <span style={{ color: t["syntax-function"] }}>app</span>
              <span style={{ color: t["syntax-punctuation"] }}>{" } "}</span>
              <span style={{ color: t["syntax-keyword"] }}>from</span>
              <span style={{ color: t["syntax-string"] }}>{" 'electron'"}</span>
            </div>
            <div style={{ height: 3 }} />
            <div>
              <span style={{ color: t["syntax-keyword"] }}>const</span>
              <span style={{ color: t["text-primary"] }}> win</span>
              <span style={{ color: t["syntax-operator"] }}> = </span>
              <span style={{ color: t["syntax-keyword"] }}>new</span>
              <span style={{ color: t["syntax-function"] }}> Window</span>
              <span style={{ color: t["syntax-punctuation"] }}>({"{"}</span>
            </div>
            <div>
              <span style={{ color: t["text-primary"] }}>{"  "}</span>
              <span style={{ color: t["text-primary"] }}>width</span>
              <span style={{ color: t["syntax-punctuation"] }}>: </span>
              <span style={{ color: t["syntax-number"] }}>1200</span>
              <span style={{ color: t["syntax-punctuation"] }}>,</span>
            </div>
            <div>
              <span style={{ color: t["syntax-comment"] }}>{"  // "}</span>
              <span style={{ color: t["syntax-comment"] }}>ready</span>
            </div>
          </div>

          {/* Terminal area */}
          <div
            className="px-2 py-1 font-mono text-[7px] leading-[10px]"
            style={{
              backgroundColor: t["surface-canvas"],
              borderTop: `1px solid ${t["border-default"]}`,
            }}
          >
            <div>
              <span style={{ color: t["terminal-green"] }}>$</span>
              <span style={{ color: t["text-primary"] }}> npm run dev</span>
            </div>
            <div>
              <span style={{ color: t["terminal-cyan"] }}>ready</span>
              <span style={{ color: t["text-muted"] }}> in 240ms</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ThemeSelectionStepProps {
  isOpen: boolean;
  onContinue: () => void;
  onSkip: () => void;
}

export function ThemeSelectionStep({ isOpen, onContinue, onSkip }: ThemeSelectionStepProps) {
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const setSelectedSchemeId = useAppThemeStore((s) => s.setSelectedSchemeId);
  const hasAutoSelected = useRef(false);

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

  useEffect(() => {
    if (!isOpen || hasAutoSelected.current) return;
    hasAutoSelected.current = true;
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    const targetId = prefersLight ? "bondi" : "daintree";
    if (selectedSchemeId !== targetId) {
      handleSelect(targetId);
    }
  }, [isOpen, selectedSchemeId, handleSelect]);

  const schemes = [daintreeScheme, bondiScheme] as const;

  return (
    <AppDialog isOpen={isOpen} onClose={onSkip} size="lg" dismissible>
      <AppDialog.Header>
        <AppDialog.Title icon={<Palette className="w-5 h-5 text-canopy-accent" />}>
          Choose your theme
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {schemes.map((scheme) => {
              const isSelected = selectedSchemeId === scheme.id;
              const isDark = scheme.type === "dark";
              return (
                <button
                  key={scheme.id}
                  onClick={() => handleSelect(scheme.id)}
                  className={cn(
                    "flex flex-col gap-2 p-3 rounded-[var(--radius-md)] border-2 transition-colors text-left",
                    isSelected
                      ? "border-canopy-accent bg-canopy-accent/10"
                      : "border-canopy-border bg-canopy-bg hover:border-canopy-text/30"
                  )}
                >
                  <ThemeMockup scheme={scheme} />
                  <div className="flex items-center justify-between px-0.5">
                    <div className="flex items-center gap-1.5">
                      {isDark ? (
                        <Moon className="w-3 h-3 text-canopy-text/50" />
                      ) : (
                        <Sun className="w-3 h-3 text-canopy-text/50" />
                      )}
                      <span className="text-sm font-medium text-canopy-text">{scheme.name}</span>
                      <span className="text-xs text-canopy-text/50">
                        {isDark ? "Dark" : "Light"}
                      </span>
                    </div>
                    {isSelected && (
                      <div className="w-4 h-4 rounded-full bg-canopy-accent flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-accent-primary-foreground" />
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <p className="text-xs text-canopy-text/50 text-center">
            More themes available in Settings → Appearance
          </p>
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
