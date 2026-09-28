import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import type { Project } from "@shared/types";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId } from "@shared/types/toolbar";

export const MENUS_PROJECT: Project = {
  id: "proj-daintree",
  path: "/Users/greg/Projects/daintree",
  name: "Daintree",
  emoji: "\u{1F333}",
  lastOpened: 1_764_000_000_000,
};

/** Two plugins' toolbar contributions, so the tray menu has groups to draw. */
export const MENUS_PLUGIN_BUTTONS: ToolbarButtonConfig[] = [
  {
    id: "acme.deploy" as PluginToolbarButtonId,
    label: "Deploy preview",
    iconId: "rocket",
    actionId: "acme.deploy",
    priority: 1,
    pluginId: "acme",
  },
  {
    id: "acme.logs" as PluginToolbarButtonId,
    label: "Tail deploy logs",
    iconId: "terminal",
    actionId: "acme.logs",
    priority: 2,
    pluginId: "acme",
  },
  {
    id: "linear.issues" as PluginToolbarButtonId,
    label: "Open Linear issues",
    iconId: "package",
    actionId: "linear.issues",
    priority: 1,
    pluginId: "linear",
  },
];

// Imported first by `menusPreview.tsx`, so the bridge shim and the platform
// override are in place before any store module or first render. Only ever a
// harness: with a real bridge on the window this page is inside the app, and
// clearing that origin's storage would clear the user's own persisted state.
const isHarness = !Reflect.get(window, "electron");

const withFallback = <T extends object>(target: T) =>
  new Proxy(target, {
    get: (t, key) => Reflect.get(t, key) ?? (async () => undefined),
  });

const noopSubscribe = () => () => {};

installPreviewShims({
  onboarding: withFallback({
    get: async () => ({
      seenAgentIds: LAUNCHABLE_AGENT_IDS.slice(),
      availabilityFirstSeen: {},
      welcomeCardDismissed: true,
      setupBannerDismissed: true,
    }),
  }),
  project: withFallback({
    getAll: async () => [MENUS_PROJECT],
    getCurrent: async () => MENUS_PROJECT,
    onSwitch: noopSubscribe,
  }),
  mcpServer: withFallback({
    getRuntimeState: async () => ({ enabled: true, state: "ready", port: 0, lastError: null }),
    onRuntimeStateChanged: noopSubscribe,
  }),
  plugin: withFallback({
    toolbarButtons: async () => MENUS_PLUGIN_BUTTONS,
    onToolbarButtonsChanged: noopSubscribe,
    onProvenanceChanged: noopSubscribe,
    list: async () => [
      {
        instanceId: "acme",
        disabled: false,
        devMode: false,
        manifest: { name: "acme", displayName: "Acme Deploy" },
      },
      {
        instanceId: "linear",
        disabled: false,
        devMode: false,
        manifest: { name: "linear", displayName: "Linear" },
      },
    ],
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

// `isMac()` reads `navigator.platform` on every call; pin it so shortcut glyphs
// and the toolbar's platform spacers resolve the same on every host.
Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
