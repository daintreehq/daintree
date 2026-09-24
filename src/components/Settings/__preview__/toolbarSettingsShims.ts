// The dev CSP requires Trusted Types; the app installs its default policy at boot.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId } from "@shared/types/toolbar";

// Imported first by `toolbarSettings.tsx`, so the bridge shim is on `window`
// before any store module evaluates. Only ever a harness: with a real bridge on
// the window this page is running inside the app, and clearing that origin's
// storage would clear the user's own persisted state.
const isHarness = !Reflect.get(window, "electron");

const fixture = new URLSearchParams(window.location.search).get("fixture") ?? "fresh";

/** Two plugin contributions, one of them promoted by the populated fixture. */
export const PREVIEW_PLUGIN_BUTTONS: ToolbarButtonConfig[] = [
  {
    id: "acme.pull-requests" as PluginToolbarButtonId,
    label: "Pull requests",
    iconId: "git-pull-request",
    actionId: "acme.pull-requests.open",
    priority: 3,
    pluginId: "acme.forge-tools",
  },
  {
    id: "acme.deploy-status" as PluginToolbarButtonId,
    label: "Deploy status",
    iconId: "gauge",
    actionId: "acme.deploy-status.open",
    priority: 3,
    pluginId: "acme.deploy",
  },
];

const withFallback = <T extends object>(target: T) =>
  new Proxy(target, {
    get: (t, key) => Reflect.get(t, key) ?? (async () => undefined),
  });

installPreviewShims({
  plugin: withFallback({
    toolbarButtons: async () => (fixture === "populated" ? PREVIEW_PLUGIN_BUTTONS : []),
    onToolbarButtonsChanged: () => () => {},
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
