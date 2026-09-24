import "./blockedNavShims";
import "./installShims";
import { useEffect, useMemo, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { DevPreviewPanelData } from "@shared/types/panel";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { usePanelStore } from "@/store/panelStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { BrowserToolbar } from "@/components/Browser/BrowserToolbar";
import { BlockedNavBanner, blockedNavReducer, type BlockedNavAction } from "../BlockedNavBanner";
import { normalizeDevPreviewUrl, toDevServerAddress } from "../urlSync";
import { DEV_SERVER_URL, PANEL_ID, PROJECT_ID, PROXY_ORIGIN } from "./fixtures";
import {
  BLOCKED_NAV_FIXTURES,
  isBlockedNavFixtureName,
  type BlockedNavFixture,
  type BlockedNavFixtureName,
} from "./blockedNavFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the dev preview's blocked-navigation
 * banner.
 *
 * Every phase past `blocked` needs a real OAuth round trip through the system
 * browser and the loopback listener, so nobody sees them side by side. This
 * mounts the REAL `ContentPanel`, `BrowserToolbar` and `BlockedNavBanner`, with
 * the banner's state produced by the real reducer, in the same `relative`
 * container `DevPreviewPane` gives the webview overlays.
 *
 * Stand-in: the page under the banner.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=blocked          one state; required
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "blocked";
const fixtureName: BlockedNavFixtureName = isBlockedNavFixtureName(fixtureParam)
  ? fixtureParam
  : "blocked";
const fixture: BlockedNavFixture = BLOCKED_NAV_FIXTURES[fixtureName];

const noop = () => {};
const PANE_HEIGHT = 300;
const ROUTE_URL = `${PROXY_ORIGIN}/checkout`;

function phaseAction(f: BlockedNavFixture): BlockedNavAction | null {
  switch (f.phase) {
    case "blocked":
      return null;
    case "oauth-started":
      return { type: "OAUTH_STARTED" };
    case "oauth-intercepting":
      return { type: "OAUTH_TOKEN_INTERCEPTED" };
    case "oauth-completed":
      return { type: "OAUTH_COMPLETED" };
    case "oauth-timed-out":
      return { type: "OAUTH_TIMED_OUT" };
    case "oauth-error":
      return { type: "OAUTH_ERROR", message: f.errorMessage ?? null, cause: f.errorCause };
  }
}

function initialState() {
  const blocked = blockedNavReducer(null, {
    type: "BLOCKED",
    url: fixture.url,
    canOpenExternal: fixture.canOpenExternal,
    sessionStorageSnapshot: [],
  });
  const next = phaseAction(fixture);
  return next ? blockedNavReducer(blocked, next) : blocked;
}

function seedStores(): void {
  const row: DevPreviewPanelData = {
    id: PANEL_ID,
    kind: "dev-preview",
    title: "Dev Server",
    location: "grid",
    cwd: "/Users/you/code/orchid-studio",
  };
  usePanelStore.setState({ panelsById: { [PANEL_ID]: row }, panelIds: [PANEL_ID] });
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });
}

function StandInPage() {
  const block = (width: string, height: number, color: string) => (
    <div style={{ width, height, background: color, borderRadius: "var(--radius-sm)" }} />
  );
  return (
    <div
      className="w-full h-full flex flex-col gap-4"
      style={{ background: "#ffffff", padding: 24 }}
      aria-hidden="true"
    >
      <div className="flex items-center justify-between">
        {block("112px", 20, "#1f2937")}
        <div className="flex gap-3">
          {block("56px", 12, "#d1d5db")}
          {block("56px", 12, "#d1d5db")}
        </div>
      </div>
      {block("50%", 28, "#e5e7eb")}
      {block("40%", 12, "#e5e7eb")}
      {block("100%", 96, "#f3f4f6")}
    </div>
  );
}

function Pane() {
  // Dismiss really dismisses, so a drive that closes the banner is visible as
  // an empty strip rather than a stale picture.
  const [state, dispatch] = useReducer(blockedNavReducer, null, initialState);

  return (
    <div
      data-fixture={fixtureName}
      className="bg-surface-canvas p-2"
      style={{ width: fixture.width, height: PANE_HEIGHT + 16 }}
    >
      <ContentPanel
        id={PANEL_ID}
        title="Dev Server"
        kind="dev-preview"
        isFocused
        location="grid"
        isMultiPanelGrid
        onFocus={noop}
        onClose={noop}
        onToggleMaximize={noop}
        onTitleChange={noop}
        onMinimize={noop}
      >
        <div className="flex flex-col h-full">
          <BrowserToolbar
            terminalId={PANEL_ID}
            projectId={PROJECT_ID}
            url={ROUTE_URL}
            canGoBack
            canGoForward={false}
            isLoading={false}
            zoomFactor={1}
            isWebviewReady
            isConsoleOpen={false}
            canOpenExternal
            canToggleConsole
            viewportPreset={undefined}
            viewportRotated={false}
            viewportDpr={1}
            viewportFit={false}
            onNavigate={noop}
            onBack={noop}
            onForward={noop}
            validateUrl={(raw) => normalizeDevPreviewUrl(raw, PROXY_ORIGIN)}
            toAddress={(target) => toDevServerAddress(target, PROXY_ORIGIN, DEV_SERVER_URL)}
            onReload={noop}
            onStop={noop}
            onHardReload={noop}
            onOpenExternal={noop}
            onPromoteToPortal={noop}
            onZoomChange={noop}
            onCaptureScreenshot={() => Promise.resolve(true)}
            onToggleDevTools={noop}
            onToggleConsole={noop}
            onViewportPresetChange={noop}
            onViewportRotateToggle={noop}
            onViewportDprChange={noop}
            onViewportFitToggle={noop}
          />
          <div className="flex-1 min-h-0 overflow-hidden">
            {/* The same nesting DevPreviewPane gives the overlays: a `relative`
                box whose first flow child is the banner and whose last is the
                webview's wrapper. */}
            <div className="h-full">
              <div className="relative h-full">
                {/* `contents`: a locator hook for the spec that adds no box. */}
                <div data-harness-banner style={{ display: "contents" }}>
                  <BlockedNavBanner
                    state={state}
                    panelId={PANEL_ID}
                    webviewElement={null}
                    onDispatch={dispatch}
                  />
                </div>
                <div className="w-full h-full">
                  <StandInPage />
                </div>
              </div>
            </div>
          </div>
        </div>
      </ContentPanel>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);
  useEffect(() => {
    seedStores();
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    // The banner's entrance is an opacity-and-slide; a capture wants it landed.
    document.body.setAttribute("data-reduce-animations", "true");
    setReady(true);
  }, [scheme]);
  if (!ready) return null;
  return (
    <WorktreeStoreProvider>
      <TooltipProvider delayDuration={0}>
        <Pane />
      </TooltipProvider>
    </WorktreeStoreProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
