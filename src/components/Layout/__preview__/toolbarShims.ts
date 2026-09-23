import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import type { Project } from "@shared/types";

export const PREVIEW_PROJECT: Project = {
  id: "proj-daintree",
  path: "/Users/greg/Projects/daintree",
  name: "Daintree",
  emoji: "\u{1F333}",
  lastOpened: 1_764_000_000_000,
};

// Imported first by `toolbar.tsx`, so the bridge shim and the platform override
// are both in place before any store module or the toolbar's first render.
// Only ever a harness: with a real bridge on the window this page is running
// inside the app, and clearing that origin's storage would clear the user's own
// persisted state.
const isHarness = !Reflect.get(window, "electron");

const withFallback = <T extends object>(target: T) =>
  new Proxy(target, {
    get: (t, key) => Reflect.get(t, key) ?? (async () => undefined),
  });

installPreviewShims({
  // Every agent already seen, so no first-run discovery dot sits on the launcher.
  onboarding: withFallback({
    get: async () => ({
      seenAgentIds: LAUNCHABLE_AGENT_IDS.slice(),
      availabilityFirstSeen: {},
      welcomeCardDismissed: true,
      setupBannerDismissed: true,
    }),
  }),
  // The toolbar and the real project-switcher hook load the project list and
  // the current project on mount; the inert shim would answer both with
  // `undefined`, which clears the pill and breaks the switcher's list.
  project: withFallback({
    getAll: async () => [PREVIEW_PROJECT],
    getCurrent: async () => PREVIEW_PROJECT,
    onSwitch: () => () => {},
  }),
  // The assistant button reads the MCP runtime snapshot on render; the inert
  // shim would hand it `undefined` and take the whole strip down with it.
  mcpServer: withFallback({
    getRuntimeState: async () => ({ enabled: true, state: "ready", port: 0, lastError: null }),
    onRuntimeStateChanged: () => () => {},
  }),
});

if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}

// `isMac()`/`isWindows()` read `navigator.platform` on every call, so the
// override decides the strip's platform spacers and the Windows app menu button.
const platform = new URLSearchParams(window.location.search).get("platform") ?? "mac";
const navigatorPlatform = platform === "windows" ? "Win32" : "MacIntel";
Object.defineProperty(navigator, "platform", { get: () => navigatorPlatform });
