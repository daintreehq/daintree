import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GridNotificationBar } from "@/components/Terminal/GridNotificationBar";
import { ProjectPluginTrustBanner } from "../ProjectPluginTrustBanner";
import { requireTrustFixture } from "./trustFixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the project plugin trust banner.
 *
 * The banner sits at the top of the panel grid, above the panels, and the
 * question it has to answer is how much of that grid it takes. So it renders
 * here in the slot it really occupies — after the grid notification bar and
 * before the panels — over a stand-in grid whose panels give up exactly the
 * room the banner claims.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=single           one state (see trustFixtures.ts)
 *   ?width=1100               window width in CSS px
 *   ?height=420               height of the grid region in CSS px
 *
 * One state per page: the banner reads a singleton store, so a sheet of rows
 * would show one state five times under five labels.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "1100");
const gridHeight = Number(params.get("height") ?? "420");
const fixtureName = params.get("fixture") ?? "single";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
// `index.css` pins the document to the window; the sheet is taller than any
// viewport, and an element screenshot of a clipped document silently drops
// the rows below the fold.
for (const el of [document.documentElement, document.body]) {
  el.style.height = "auto";
  el.style.minHeight = "100vh";
  el.style.overflow = "visible";
}

/** A stand-in for the toolbar above the grid, so the region has a top edge to meet. */
function ToolbarStrip() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-divider px-4 surface-toolbar"
    >
      <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
      <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
      <div className="mx-auto h-7 w-56 rounded-[var(--radius-md)] bg-overlay-subtle" />
      <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
      <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
    </div>
  );
}

/** Two panel-shaped boxes on the grid surface: the thing the banner takes room from. */
function PanelGrid() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="relative flex-1 min-h-0 bg-noise p-1"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: "4px",
        backgroundColor: "var(--color-grid-bg)",
      }}
    >
      {[0, 1].map((i) => (
        <div
          key={i}
          className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-default bg-surface-panel"
        >
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3">
            <div className="h-3 w-3 rounded-full bg-overlay-subtle" />
            <div className="h-3 w-28 rounded-sm bg-overlay-subtle" />
          </div>
          <div className="flex-1 p-3 font-mono text-xs leading-5 text-text-secondary">
            <div>$ npm run dev</div>
            <div className="text-text-muted">vite v8.0.14 ready in 412 ms</div>
            <div className="text-text-muted">➜ Local: http://localhost:5173/</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The panel grid region as `ContentGridDefault` lays it out, with the real strips in their real order. */
function GridRegion() {
  return (
    <div data-grid-host>
      <div className="flex flex-col" style={{ height: gridHeight }}>
        <ToolbarStrip />
        <div className="flex flex-1 min-h-0 flex-col" role="region" aria-label="Panels">
          <GridNotificationBar className="mx-1 mt-1 shrink-0" />
          <div data-banner-slot className="contents">
            <ProjectPluginTrustBanner />
          </div>
          <PanelGrid />
        </div>
      </div>
    </div>
  );
}

// Seed before mounting: a store write during render is a cross-component
// update React rightly complains about, and the banner reads on first render.
requireTrustFixture(fixtureName).seed();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell className="flex flex-col" style={{ width }}>
        <GridRegion />
      </div>
    </TooltipProvider>
  </StrictMode>
);
