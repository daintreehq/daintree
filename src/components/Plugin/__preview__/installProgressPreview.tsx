import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, ChevronDown, ChevronLeft, Download, Package, X } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import type { PluginInstallProgressEvent } from "@shared/types/plugin";
import { PluginInstallProgressBanner } from "../PluginInstallProgressBanner";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the Plugin Manager's install progress
 * banner.
 *
 * The banner spans the full-window Plugin Manager directly under its title bar,
 * so it renders here in that slot: a stand-in header above, the stand-in
 * master/detail below, and — for one fixture — the restart-required banner that
 * can share the band with it.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=extracting       one state (see FIXTURES)
 *   ?width=1100               window width in CSS px
 *
 * The banner is prop-driven — `usePluginManager` owns the job state and passes
 * it straight through — so each fixture is the exact prop set the hook produces
 * at that point in an install.
 */

interface InstallFixture {
  progress: PluginInstallProgressEvent | null;
  cancelRequested?: boolean;
  restartRequired?: boolean;
}

const event = (over: Partial<PluginInstallProgressEvent>): PluginInstallProgressEvent => ({
  jobId: "preview-job",
  phase: "downloading",
  cancellable: true,
  ...over,
});

const FIXTURES: Record<string, InstallFixture> = {
  starting: { progress: null },
  downloading: { progress: event({ phase: "downloading" }) },
  extracting: { progress: event({ phase: "extracting", entry: "dist/index.js" }) },
  "extracting-long": {
    progress: event({
      phase: "extracting",
      entry: "node_modules/@acme/telemetry-exporter/dist/esm/internal/transports/grpcTransport.js",
    }),
  },
  validating: { progress: event({ phase: "validating" }) },
  activating: { progress: event({ phase: "activating", cancellable: false }) },
  "still-working": { progress: event({ phase: "downloading" }) },
  cancelling: {
    progress: event({ phase: "extracting", entry: "assets/icon.png" }),
    cancelRequested: true,
  },
  "with-restart": {
    progress: event({ phase: "extracting", entry: "dist/panel/index.html" }),
    restartRequired: true,
  },
};

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "1100");
const fixtureName = params.get("fixture") ?? "extracting";
const fixture = FIXTURES[fixtureName];
if (!fixture) throw new Error(`unknown install-progress fixture "${fixtureName}"`);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function HeaderStandIn() {
  return (
    <header
      data-harness-decoration
      className="flex items-center justify-between gap-3 px-6 h-12 shrink-0 border-b border-border-default"
    >
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-16 shrink-0" aria-hidden="true" />
        <Button variant="ghost" size="icon-sm" aria-label="Back" tabIndex={-1}>
          <ChevronLeft />
        </Button>
        <Package className="w-5 h-5 text-text-secondary shrink-0" aria-hidden="true" />
        <h2 className="text-sm font-medium text-text-primary truncate">Plugins</h2>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" tabIndex={-1}>
          <Download />
          Install plugin
          <ChevronDown className="text-text-secondary" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close plugin manager" tabIndex={-1}>
          <X />
        </Button>
      </div>
    </header>
  );
}

/** The installed list and detail pane the banner pushes down. */
function BodyStandIn() {
  return (
    <div data-harness-decoration aria-hidden="true" className="flex flex-1 min-h-0">
      <div className="w-80 shrink-0 border-r border-border-default flex flex-col">
        <div className="p-3 border-b border-border-default space-y-2">
          <div className="h-7 rounded-[var(--radius-md)] bg-overlay-subtle" />
          <div className="flex gap-1">
            {[44, 56, 40, 52].map((w) => (
              <div key={w} className="h-4 rounded-sm bg-overlay-subtle" style={{ width: w }} />
            ))}
          </div>
        </div>
        {["GitHub", "Linear", "Sentry", "Vercel"].map((name, i) => (
          <div
            key={name}
            className={
              i === 0
                ? "flex items-center gap-2 px-3 py-2 bg-overlay-soft"
                : "flex items-center gap-2 px-3 py-2"
            }
          >
            <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-medium" />
            <div className="flex-1 space-y-1">
              <div className="text-sm text-text-primary">{name}</div>
              <div className="h-2 w-32 rounded-sm bg-overlay-subtle" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex-1 p-6 space-y-3">
        <div className="h-5 w-48 rounded-sm bg-overlay-medium" />
        <div className="h-3 w-80 rounded-sm bg-overlay-subtle" />
        <div className="h-3 w-72 rounded-sm bg-overlay-subtle" />
      </div>
    </div>
  );
}

function Shell() {
  return (
    <div
      data-preview-shell
      className="flex flex-col bg-surface-canvas"
      style={{ width, height: 420 }}
    >
      <HeaderStandIn />
      {fixture!.restartRequired && (
        <InlineStatusBanner
          icon={AlertTriangle}
          title="Restart required to apply plugin changes"
          severity="warning"
          role="status"
          animated={false}
          actions={[{ id: "restart", label: "Restart", variant: "primary", onClick: () => {} }]}
        />
      )}
      <div data-install-progress className="contents">
        <PluginInstallProgressBanner
          isInstalling
          progress={fixture!.progress}
          cancelRequested={fixture!.cancelRequested ?? false}
          onCancel={() => {}}
        />
      </div>
      <BodyStandIn />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Shell />
    </TooltipProvider>
  </StrictMode>
);
