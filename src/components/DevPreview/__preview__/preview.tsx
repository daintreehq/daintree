import "./installShims";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import type { DevPreviewPanelData } from "@shared/types/panel";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { usePanelStore } from "@/store/panelStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { BrowserToolbar } from "@/components/Browser/BrowserToolbar";
import { SiteBuilderButton } from "../../../../plugins/builtin/sveltekit-builder/renderer/SiteBuilderButton";
import { toDevServerAddress } from "../urlSync";
import {
  DEV_SERVER_URL,
  FIXTURES,
  PANEL_ID,
  PROJECT_ID,
  PROXY_ORIGIN,
  isFixtureName,
  type DevPreviewChromeFixture,
  type FixtureName,
} from "./fixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the dev preview's chrome.
 *
 * The toolbar's states belong to a live dev server — a page mid-load, a server
 * that stopped, a console drawer open beside a framework tool, a device preset
 * with its rotate/DPR/fit controls. Reaching each one in the app is a cold dev
 * server per state, so this mounts the REAL `ContentPanel` (kind `dev-preview`)
 * and the REAL `BrowserToolbar` with the props `DevPreviewPane` hands it, plus the
 * real SvelteKit Tools toggle, against the real theme tokens and `index.css`.
 *
 * Stand-ins: the dev-script switcher in the header (a copy of the trigger
 * `useDevPreviewCommandConfig` renders, which needs project settings over IPC)
 * and the page under the toolbar.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=rest             one state; required
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "rest";
const fixtureName: FixtureName = isFixtureName(fixtureParam) ? fixtureParam : "rest";
const fixture: DevPreviewChromeFixture = FIXTURES[fixtureName];

const noop = () => {};
const PANE_HEIGHT = 300;

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
  const now = Date.now();
  useUrlHistoryStore.setState({
    entries: {
      [PROJECT_ID]: [
        { url: `${PROXY_ORIGIN}/`, title: "Orchid Studio", visitCount: 40, lastVisitAt: now },
        {
          url: `${PROXY_ORIGIN}/dashboard`,
          title: "Dashboard · Orchid Studio",
          visitCount: 22,
          lastVisitAt: now - 60_000,
        },
        {
          url: `${PROXY_ORIGIN}/dashboard/projects/orchid-studio/settings?tab=billing`,
          title: "Billing settings · Orchid Studio",
          visitCount: 6,
          lastVisitAt: now - 3_600_000,
        },
        {
          url: `${PROXY_ORIGIN}/pricing`,
          title: "Pricing · Orchid Studio",
          visitCount: 3,
          lastVisitAt: now - 86_400_000,
        },
      ],
    },
  } as Partial<ReturnType<typeof useUrlHistoryStore.getState>>);
}

function DevScriptSwitcherStandIn() {
  return (
    <button
      type="button"
      className="flex h-6 items-center gap-1 px-1.5 rounded-sm hover:bg-overlay-soft text-text-secondary hover:text-text-primary transition-colors min-w-0 max-w-[180px]"
      aria-label="Switch dev script"
    >
      <span className="min-w-0 text-xs truncate">dev</span>
      <ChevronDown className="h-3 w-3 shrink-0" />
    </button>
  );
}

function StandInPage() {
  const block = (width: string, height: number, color: string) => (
    <div style={{ width, height, background: color, borderRadius: 4 }} />
  );
  return (
    <div
      className="flex-1 min-h-0 flex flex-col gap-4"
      style={{ background: "#ffffff", padding: 24 }}
      aria-hidden="true"
    >
      <div className="flex items-center justify-between">
        {block("112px", 20, "#1f2937")}
        <div className="flex gap-3">
          {block("56px", 12, "#d1d5db")}
          {block("56px", 12, "#d1d5db")}
          {block("56px", 12, "#d1d5db")}
        </div>
      </div>
      {block("66%", 32, "#e5e7eb")}
      {block("50%", 12, "#e5e7eb")}
      {block("100%", 96, "#f3f4f6")}
    </div>
  );
}

function Pane() {
  const [consoleOpen, setConsoleOpen] = useState(fixture.consoleOpen ?? false);
  const [toolActive, setToolActive] = useState(fixture.toolActive ?? false);
  const [zoom, setZoom] = useState(fixture.zoomFactor ?? 1);
  const [preset, setPreset] = useState(fixture.viewportPreset);
  const [dpr, setDpr] = useState<1 | 2 | 3>(fixture.viewportDpr ?? 1);
  const [rotated, setRotated] = useState(fixture.viewportRotated ?? false);
  const [fit, setFit] = useState(fixture.viewportFit ?? false);
  const url = `${PROXY_ORIGIN}${fixture.route}`;

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
        isFocused={fixture.isFocused ?? true}
        location="grid"
        isMultiPanelGrid
        onFocus={noop}
        onClose={noop}
        onToggleMaximize={noop}
        onTitleChange={noop}
        onMinimize={noop}
        headerContent={<DevScriptSwitcherStandIn />}
      >
        <div className="flex flex-col h-full">
          <BrowserToolbar
            terminalId={PANEL_ID}
            projectId={PROJECT_ID}
            url={url}
            canGoBack={fixture.canGoBack ?? false}
            canGoForward={fixture.canGoForward ?? false}
            isLoading={fixture.isLoading ?? false}
            zoomFactor={zoom}
            isWebviewReady={fixture.isWebviewReady ?? true}
            isConsoleOpen={consoleOpen}
            canOpenExternal
            canToggleConsole={fixture.canToggleConsole ?? true}
            viewportPreset={preset}
            viewportRotated={rotated}
            viewportDpr={dpr}
            viewportFit={fit}
            onNavigate={noop}
            onBack={noop}
            onForward={noop}
            toAddress={(target) => toDevServerAddress(target, PROXY_ORIGIN, DEV_SERVER_URL)}
            onReload={noop}
            onStop={noop}
            onHardReload={noop}
            onOpenExternal={noop}
            onPromoteToPortal={noop}
            onZoomChange={setZoom}
            onCaptureScreenshot={() => Promise.resolve(true)}
            onToggleDevTools={noop}
            onToggleConsole={() => setConsoleOpen((v) => !v)}
            onViewportPresetChange={setPreset}
            onViewportRotateToggle={() => setRotated((v) => !v)}
            onViewportDprChange={setDpr}
            onViewportFitToggle={() => setFit((v) => !v)}
            extraActions={
              <SiteBuilderButton
                panelId={PANEL_ID}
                projectId={PROJECT_ID}
                worktreeId="wt-1"
                worktreePath="/Users/you/code/orchid-studio"
                url={url}
                isWebviewReady
                active={toolActive}
                onToggle={() => setToolActive((v) => !v)}
              />
            }
          />
          <StandInPage />
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
