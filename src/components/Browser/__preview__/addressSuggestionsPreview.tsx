import "@/components/DevPreview/__preview__/installShims";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { BrowserPanelData, DevPreviewPanelData } from "@shared/types/panel";
import type { UrlHistoryEntry } from "@shared/types/browser";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { usePanelStore } from "@/store/panelStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";
import { hostScopedKey } from "@/hooks/useHostPlatform";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { BrowserToolbar } from "@/components/Browser/BrowserToolbar";
import { normalizeBrowserUrl } from "@/components/Browser/browserUtils";
import { normalizeDevPreviewUrl, toDevServerAddress } from "@/components/DevPreview/urlSync";
import { DEV_SERVER_URL, PROXY_ORIGIN } from "@/components/DevPreview/__preview__/fixtures";
import {
  ADDRESS_SUGGESTION_FIXTURES,
  PANEL_ID,
  PROJECT_ID,
  isAddressSuggestionsFixtureName,
  type AddressSuggestionsFixture,
  type AddressSuggestionsFixtureName,
} from "./addressSuggestionsFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the browser address bar's history
 * suggestions.
 *
 * The list only exists while the field is focused and typed into, against a
 * project's real visit history, so nobody sees its long-URL, untitled and
 * narrow-pane cases side by side. This mounts the REAL `ContentPanel` and
 * `BrowserToolbar`, with the history pushed through `useUrlHistoryStore`, and
 * leaves the typing and the pointer to the spec.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=typed            one state; required
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "typed";
const fixtureName: AddressSuggestionsFixtureName = isAddressSuggestionsFixtureName(fixtureParam)
  ? fixtureParam
  : "typed";
const fixture: AddressSuggestionsFixture = ADDRESS_SUGGESTION_FIXTURES[fixtureName];

const noop = () => {};
const PANE_HEIGHT = fixture.height ?? 440;
const CURRENT_URL = "https://github.com/daintreehq/daintree";

const svgIcon = (body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`
  )}`;
const GITHUB_ICON = svgIcon(
  '<circle cx="8" cy="8" r="8" fill="#24292f"/><circle cx="8" cy="7" r="3.2" fill="#fff"/><rect x="6.6" y="9.5" width="2.8" height="4" fill="#fff"/>'
);
const DOCS_ICON = svgIcon(
  '<rect width="16" height="16" rx="3" fill="#0969da"/><rect x="4" y="4" width="8" height="1.6" fill="#fff"/><rect x="4" y="7.2" width="8" height="1.6" fill="#fff"/><rect x="4" y="10.4" width="5" height="1.6" fill="#fff"/>'
);
const MDN_ICON = svgIcon(
  '<rect width="16" height="16" rx="3" fill="#1b1b1b"/><path d="M3 12V4l3 4 3-4v8" stroke="#fff" stroke-width="1.6" fill="none"/><rect x="11" y="4" width="1.6" height="8" fill="#fff"/>'
);
// A favicon the page advertised and then 404s: the row falls back to the globe.
const BROKEN_ICON = "data:image/png;base64,AAAA";

function browserHistory(now: number): UrlHistoryEntry[] {
  const minutes = (n: number) => now - n * 60_000;
  return [
    {
      url: "https://github.com/daintreehq/daintree/pull/13379",
      title:
        "feat(hosts): show each host's exchanges on the hosts overview by gpriday · Pull Request #13379 · daintreehq/daintree",
      favicon: GITHUB_ICON,
      visitCount: 14,
      lastVisitAt: minutes(5),
    },
    {
      url: "https://github.com/daintreehq/daintree/pull/13380",
      title:
        "feat(assistant): let host assistants message the hub with assistant.sendMessage by gpriday · Pull Request #13380 · daintreehq/daintree",
      favicon: GITHUB_ICON,
      visitCount: 11,
      lastVisitAt: minutes(12),
    },
    {
      url: "https://docs.github.com/en/rest/pulls/review-requests?apiVersion=2022-11-28#request-reviewers-for-a-pull-request",
      title: "REST API endpoints for review requests - GitHub Docs",
      favicon: DOCS_ICON,
      visitCount: 7,
      lastVisitAt: minutes(40),
    },
    {
      url: "https://github.com/daintreehq/daintree/issues?q=is%3Aissue%20state%3Aopen%20label%3Abrowser%20sort%3Aupdated-desc",
      title: "Issues · daintreehq/daintree",
      favicon: GITHUB_ICON,
      visitCount: 6,
      lastVisitAt: minutes(90),
    },
    {
      url: "https://gist.github.com/gpriday/9f3c1d7e2b8a4c60f1e5d2a7b3c9e8f4",
      title: "",
      favicon: BROKEN_ICON,
      visitCount: 3,
      lastVisitAt: minutes(200),
    },
    {
      url: "https://github.com/settings/tokens",
      title: "Personal access tokens (classic)",
      favicon: GITHUB_ICON,
      visitCount: 2,
      lastVisitAt: minutes(600),
    },
    {
      url: "http://localhost:3000/dashboard/projects/orchid-studio/settings?tab=billing",
      title: "",
      visitCount: 9,
      lastVisitAt: minutes(20),
    },
    {
      url: "http://localhost:3000/",
      title: "Orchid Studio",
      visitCount: 5,
      lastVisitAt: minutes(25),
    },
    {
      url: "https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/combobox_role",
      title: "ARIA: combobox role - ARIA | MDN",
      favicon: MDN_ICON,
      visitCount: 4,
      lastVisitAt: minutes(300),
    },
  ];
}

function devPreviewHistory(now: number): UrlHistoryEntry[] {
  return [
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
  ];
}

function seedStores(): void {
  const row: BrowserPanelData | DevPreviewPanelData =
    fixture.host === "dev-preview"
      ? {
          id: PANEL_ID,
          kind: "dev-preview",
          title: "Dev server",
          location: "grid",
          cwd: "/Users/you/code/orchid-studio",
        }
      : { id: PANEL_ID, kind: "browser", title: "Browser", location: "grid" };
  usePanelStore.setState({ panelsById: { [PANEL_ID]: row }, panelIds: [PANEL_ID] });
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });
  const now = Date.now();
  useUrlHistoryStore.setState({
    entries: {
      [hostScopedKey(PROJECT_ID)]:
        fixture.host === "dev-preview" ? devPreviewHistory(now) : browserHistory(now),
    },
  } as Partial<ReturnType<typeof useUrlHistoryStore.getState>>);
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
  const isDevPreview = fixture.host === "dev-preview";
  const url = isDevPreview ? `${PROXY_ORIGIN}/` : CURRENT_URL;
  return (
    <div
      data-fixture={fixtureName}
      className="bg-surface-canvas p-2"
      style={{ width: fixture.width, height: PANE_HEIGHT + 16 }}
    >
      <ContentPanel
        id={PANEL_ID}
        title={isDevPreview ? "Dev server" : "Browser"}
        kind={isDevPreview ? "dev-preview" : "browser"}
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
            url={url}
            canGoBack
            canGoForward={false}
            isLoading={false}
            zoomFactor={1}
            isWebviewReady
            isConsoleOpen={false}
            canOpenExternal
            canToggleConsole={isDevPreview}
            onNavigate={noop}
            onBack={noop}
            onForward={noop}
            validateUrl={
              isDevPreview
                ? (raw) => normalizeDevPreviewUrl(raw, PROXY_ORIGIN)
                : (raw) => normalizeBrowserUrl(raw, { allowedHosts: [] })
            }
            toAddress={
              isDevPreview
                ? (target) => toDevServerAddress(target, PROXY_ORIGIN, DEV_SERVER_URL)
                : undefined
            }
            onReload={noop}
            onStop={noop}
            onHardReload={noop}
            onOpenExternal={noop}
            onPromoteToPortal={noop}
            onZoomChange={noop}
            onCaptureScreenshot={() => Promise.resolve(true)}
            onToggleDevTools={noop}
            onToggleConsole={isDevPreview ? noop : undefined}
          />
          <div className="flex-1 min-h-0 overflow-hidden">
            <StandInPage />
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
