import "./panelLimitShims";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { preflightSpawnBatchLimit, usePanelLimitStore } from "@/store/panelLimitStore";
import { PanelLimitConfirmDialog } from "../PanelLimitConfirmDialog";
import { requirePanelLimitFixture } from "./panelLimitFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the panel-limit confirm dialog.
 *
 * The dialog only appears when a batch spawn crosses the confirmation threshold,
 * which in the app means opening twenty-odd panels first. This mounts the real
 * dialog against the real store and `index.css`, and opens it by calling
 * `preflightSpawnBatchLimit` with the fixture's counts — the same call a recipe
 * run makes — so the copy is judged against numbers the product really produces.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=batch|…          see panelLimitFixtures.ts
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixture = requirePanelLimitFixture(params.get("fixture") ?? "batch");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

usePanelLimitStore.setState({
  confirmationLimit: fixture.confirmationLimit,
  hardLimit: fixture.hardLimit,
  softWarningLimit: Math.min(fixture.confirmationLimit, 12),
  warningsDisabled: false,
  hardwareDefaultsApplied: true,
});

/** Panel-shaped boxes behind the scrim, so the dialog is judged over an app rather than a void. */
function BackdropGrid() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="grid h-screen gap-1 p-1"
      style={{
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        backgroundColor: "var(--color-grid-bg)",
      }}
    >
      {Array.from({ length: 8 }, (_, i) => (
        <div
          key={i}
          className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-default bg-surface-panel"
        >
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3">
            <div className="h-3 w-3 rounded-full bg-overlay-subtle" />
            <div className="h-3 w-24 rounded-sm bg-overlay-subtle" />
          </div>
          <div className="flex-1 p-3 font-mono text-xs leading-5 text-text-muted">
            <div>$ npm run dev</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Fires the fixture's batch once the host has committed, as in the app, where
 * the dialog host is mounted long before any batch asks. The resolved value is
 * recorded for the spec.
 */
/** Long enough for the StrictMode double-mount to have settled. */
const BATCH_DELAY_MS = 50;

function StartBatch() {
  useEffect(() => {
    const timer = setTimeout(() => {
      void preflightSpawnBatchLimit(fixture.currentCount, fixture.requestedCount, {
        sourceName: fixture.sourceName,
      }).then((result) => {
        document.documentElement.dataset.preflightAllowed = String(result.allowed);
      });
    }, BATCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell>
        <BackdropGrid />
        <PanelLimitConfirmDialog />
        <StartBatch />
      </div>
    </TooltipProvider>
  </StrictMode>
);
