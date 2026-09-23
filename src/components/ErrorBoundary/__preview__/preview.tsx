import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "../ErrorBoundary";
import type { ErrorFallbackProps } from "../ErrorFallback";
import { WorktreeCardErrorFallback } from "@/components/Worktree/WorktreeCardErrorFallback";
import { PluginViewDiagnosticsFallback } from "@/components/Plugin/PluginViewDiagnosticsFallback";
import { renderBootstrapError } from "@/utils/renderBootstrapError";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the error-boundary fallback family.
 *
 * A crash screen is only ever seen when something has already broken, which is
 * exactly why nobody looks at it. This page throws through the real
 * `ErrorBoundary` at each variant and at the sizes the app actually gives it,
 * against the real theme tokens and `index.css`. It is a Vite entry of its own
 * (`crash-screen-preview.html`) and never reaches the app bundle, so the throw
 * is a trigger no user can hit.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=fullscreen       see FIXTURES below, plus `bootstrap` (boot failure)
 *
 * The toolbar, sidebar and panel chrome drawn around the fallbacks are harness
 * decoration, so a reviewer can judge the fallback against the frame it
 * replaces. They are not the app's.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixture = params.get("fixture") ?? "fullscreen";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

// Incident IDs are minted from randomUUID; pin it so captures from one round to
// the next differ only where the design did.
const PINNED_UUID = "3f9c2a71-5b8e-4d0a-9c61-7e2b4f8d1a05";
crypto.randomUUID = () => PINNED_UUID;

/**
 * Shaped like a packaged build's stack, home directory included, so the scrubbed
 * production rendering has something real to scrub.
 */
function makeError(): Error {
  const error = new TypeError("Cannot read properties of undefined (reading 'branch')");
  error.stack = [
    "TypeError: Cannot read properties of undefined (reading 'branch')",
    "    at WorktreeSummary (file:///Users/alex/Applications/Daintree.app/Contents/Resources/app.asar/dist/assets/index-C3f9a1d2.js:1:482211)",
    "    at renderWithHooks (file:///Users/alex/Applications/Daintree.app/Contents/Resources/app.asar/dist/assets/react-dom-B82k0q.js:1:51208)",
    "    at updateFunctionComponent (file:///Users/alex/Applications/Daintree.app/Contents/Resources/app.asar/dist/assets/react-dom-B82k0q.js:1:88412)",
    "    at beginWork (file:///Users/alex/Applications/Daintree.app/Contents/Resources/app.asar/dist/assets/react-dom-B82k0q.js:1:103977)",
    "    at performUnitOfWork (file:///Users/alex/Applications/Daintree.app/Contents/Resources/app.asar/dist/assets/react-dom-B82k0q.js:1:142630)",
    "    at workLoopSync (file:///Users/alex/Applications/Daintree.app/Contents/Resources/app.asar/dist/assets/react-dom-B82k0q.js:1:142501)",
  ].join("\n");
  return error;
}

function Thrower(): ReactNode {
  throw makeError();
}

function ToolbarStrip() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-divider px-4 surface-toolbar"
    >
      <div className="h-6 w-24 rounded-[var(--radius-md)] bg-overlay-subtle" />
      <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
      <div className="ml-auto h-6 w-32 rounded-[var(--radius-md)] bg-overlay-subtle" />
    </div>
  );
}

function FakeCard({ muted = false }: { muted?: boolean }) {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex flex-col gap-2 border-b border-divider px-4 py-3"
    >
      <div
        className="h-3 rounded-[var(--radius-sm)] bg-overlay-subtle"
        style={{ width: muted ? 120 : 170 }}
      />
      <div className="h-2.5 w-24 rounded-[var(--radius-sm)] bg-overlay-subtle" />
    </div>
  );
}

function SidebarDecoration() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex h-full shrink-0 flex-col border-r border-divider bg-surface-sidebar"
      style={{ width: 300 }}
    >
      <FakeCard />
      <FakeCard muted />
      <FakeCard />
    </div>
  );
}

function PanelFrame({
  title,
  width,
  height,
  children,
}: {
  title: string;
  width: number;
  height: number;
  children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-divider bg-surface-panel"
      style={{ width, height }}
    >
      <div
        data-harness-decoration
        aria-hidden="true"
        className="flex h-8 shrink-0 items-center border-b border-divider px-3 text-xs text-text-secondary"
      >
        {title}
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

function AppFrame({ sidebar, main }: { sidebar: ReactNode; main: ReactNode }) {
  return (
    <div data-preview-shell className="flex h-screen w-screen flex-col bg-surface-canvas">
      <ToolbarStrip />
      <div className="flex min-h-0 flex-1">
        {sidebar}
        <div className="min-h-0 min-w-0 flex-1">{main}</div>
      </div>
    </div>
  );
}

function GridDecoration() {
  return (
    <div data-harness-decoration aria-hidden="true" className="flex h-full gap-2 p-2">
      <div className="flex-1 rounded-[var(--radius-lg)] border border-divider bg-surface-panel" />
      <div className="flex-1 rounded-[var(--radius-lg)] border border-divider bg-surface-panel" />
    </div>
  );
}

const PLUGIN_COMPONENT_PATH = "plugin://acme-insights/dist/views/dashboard.js";

function makePluginFallback(devMode: boolean) {
  return function PluginFallback({ error, errorInfo, resetError, incidentId }: ErrorFallbackProps) {
    return (
      <PluginViewDiagnosticsFallback
        error={error}
        errorInfo={errorInfo}
        resetError={resetError}
        incidentId={incidentId}
        pluginId="acme-insights"
        pluginDisplayName="Acme Insights"
        kindId="acme-insights.dashboard"
        panelDisplayName="Dashboard"
        componentPath={PLUGIN_COMPONENT_PATH}
        devMode={devMode}
        onRequestClose={() => undefined}
      />
    );
  };
}
const PluginFallbackInstalled = makePluginFallback(false);
const PluginFallbackDev = makePluginFallback(true);

function PanelGrid({ children }: { children: ReactNode }) {
  return (
    <div data-preview-shell className="flex h-screen w-screen items-start gap-3 p-4">
      {children}
    </div>
  );
}

const FIXTURES: Record<string, () => ReactNode> = {
  fullscreen: () => (
    <div data-preview-shell>
      <ErrorBoundary variant="fullscreen" componentName="App">
        <Thrower />
      </ErrorBoundary>
    </div>
  ),
  "section-main": () => (
    <AppFrame
      sidebar={<SidebarDecoration />}
      main={
        <ErrorBoundary variant="section" componentName="ContentGrid">
          <Thrower />
        </ErrorBoundary>
      }
    />
  ),
  "section-sidebar": () => (
    <AppFrame
      sidebar={
        <div
          className="h-full shrink-0 border-r border-divider bg-surface-sidebar"
          style={{ width: 300 }}
        >
          <ErrorBoundary variant="section" componentName="Sidebar">
            <Thrower />
          </ErrorBoundary>
        </div>
      }
      main={<GridDecoration />}
    />
  ),
  "component-panel": () => (
    <PanelGrid>
      <PanelFrame title="Review" width={620} height={420}>
        <ErrorBoundary variant="component" componentName="ReviewPane">
          <Thrower />
        </ErrorBoundary>
      </PanelFrame>
      <PanelFrame title="File" width={300} height={200}>
        <ErrorBoundary variant="component" componentName="FilePane">
          <Thrower />
        </ErrorBoundary>
      </PanelFrame>
    </PanelGrid>
  ),
  "worktree-card": () => (
    <div data-preview-shell className="h-screen w-screen">
      <div className="h-full border-r border-divider bg-surface-sidebar" style={{ width: 300 }}>
        <FakeCard />
        <ErrorBoundary
          variant="component"
          componentName="WorktreeCard"
          displayName="feature/billing-export-retry-queue"
          fallback={WorktreeCardErrorFallback}
        >
          <Thrower />
        </ErrorBoundary>
        <FakeCard muted />
        <FakeCard />
      </div>
    </div>
  ),
  "plugin-installed": () => (
    <PanelGrid>
      <PanelFrame title="Dashboard" width={640} height={520}>
        <ErrorBoundary
          variant="component"
          componentName="PluginView:acme-insights.dashboard"
          fallback={PluginFallbackInstalled}
        >
          <Thrower />
        </ErrorBoundary>
      </PanelFrame>
    </PanelGrid>
  ),
  "plugin-dev": () => (
    <PanelGrid>
      <PanelFrame title="Dashboard" width={640} height={520}>
        <ErrorBoundary
          variant="component"
          componentName="PluginView:acme-insights.dashboard"
          fallback={PluginFallbackDev}
        >
          <Thrower />
        </ErrorBoundary>
      </PanelFrame>
    </PanelGrid>
  ),
};

const rootEl = document.getElementById("root")!;

if (fixture === "bootstrap") {
  // The boot-failure screen is plain DOM painted before React ever mounts, so
  // it is drawn directly rather than through a boundary.
  renderBootstrapError(rootEl, makeError());
  rootEl.setAttribute("data-preview-shell", "");
} else {
  const render = FIXTURES[fixture];
  if (!render) throw new Error(`Unknown crash-screen fixture "${fixture}"`);

  createRoot(rootEl).render(
    <StrictMode>
      <TooltipProvider>{render()}</TooltipProvider>
    </StrictMode>
  );
}
