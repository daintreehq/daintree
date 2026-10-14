import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePaletteStore } from "@/store/paletteStore";
import { useHostMetricsStore } from "@/store/hostMetricsStore";
import { HOST_SWITCHER_PALETTE_ID, HostSwitcherPalette } from "../HostSwitcherPalette";
import { historyFor, requireFixture } from "./hostSwitcherFixtures";
import "@/index.css";

/**
 * Visual-review harness for "Switch host…": the real palette against a seeded
 * host list, metrics history and window host.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…           built-in theme id
 *   ?fixture=fleet|remote|search|…    see hostSwitcherFixtures
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixture = requireFixture(params.get("fixture") ?? "fleet");

if (fixture.currentHostId) window.__DAINTREE_HOST_ID__ = { id: fixture.currentHostId };

installPreviewShims({
  remoteHosts: {
    list: async () => fixture.hosts,
    listRecent: async () => fixture.recent,
    onEvent: () => () => undefined,
    isInUse: async () => true,
  },
  hostMetrics: {
    getSnapshots: async () => [],
    onEvent: (listener: (event: unknown) => void) => {
      if (fixture.localSummary) {
        queueMicrotask(() => listener({ type: "summary", summary: fixture.localSummary }));
      }
      return () => undefined;
    },
  },
});

const history = new Map();
if (fixture.localSummary) history.set("local", historyFor(fixture.localSummary, 120, 9));
for (const host of fixture.hosts) {
  if (host.summary && host.connection.status === "connected") {
    history.set(host.descriptor.id, historyFor(host.summary, 180, 14));
  }
}
useHostMetricsStore.setState({ history });

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";

usePaletteStore.getState().openPalette(HOST_SWITCHER_PALETTE_ID);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell />
      <HostSwitcherPalette />
    </TooltipProvider>
  </StrictMode>
);
