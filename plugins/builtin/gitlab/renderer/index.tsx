import { lazy } from "react";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { GitLabIcon } from "@/components/icons/brands";

// The kit chunk loads with the tab: its components render nothing until it is
// in, and waiting for it here keeps the tab's first frame whole.
const GitLabSettingsTab = lazy(() =>
  Promise.all([
    import("./components/GitLabSettingsTab"),
    import("@/components/PluginKit/PluginKit"),
  ])
    // One task, so the kit's own import callback has run and its components
    // render synchronously; the kit exposes no ready promise to await instead.
    .then(([m]) => new Promise<typeof m>((resolve) => setTimeout(resolve, 0, m)))
    .then((m) => ({ default: m.GitLabSettingsTab }))
);

// Registration stays synchronous while the settings view loads only when
// rendered. The ids must match the manifest's `slots` values exactly.
registerBuiltinView("gitlab.forgeSettingsTab", GitLabSettingsTab, {
  pluginId: "daintree.gitlab",
});
registerBuiltinView("gitlab.providerIcon", GitLabIcon, { pluginId: "daintree.gitlab" });
