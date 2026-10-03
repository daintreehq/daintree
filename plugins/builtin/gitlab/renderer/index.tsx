import { lazy } from "react";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { GitLabIcon } from "@/components/icons/brands";

// The kit loads with the tab: its components render nothing until it is ready,
// and waiting for it here keeps the tab's first frame whole. Dynamic, because
// this entry is eager and the kit must stay off the startup path.
const GitLabSettingsTab = lazy(() =>
  Promise.all([
    import("./components/GitLabSettingsTab"),
    import("@daintreehq/plugin-ui").then((kit) => kit.whenPluginUiReady()),
  ]).then(([m]) => ({ default: m.GitLabSettingsTab }))
);

// Registration stays synchronous while the settings view loads only when
// rendered. The ids must match the manifest's `slots` values exactly.
registerBuiltinView("gitlab.forgeSettingsTab", GitLabSettingsTab, {
  pluginId: "daintree.gitlab",
});
registerBuiltinView("gitlab.providerIcon", GitLabIcon, { pluginId: "daintree.gitlab" });
