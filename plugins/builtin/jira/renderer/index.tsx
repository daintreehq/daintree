import { lazy } from "react";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { JiraIcon } from "@/components/icons/brands";

// The kit loads with the tab: its components render nothing until it is ready,
// and waiting for it here keeps the tab's first frame whole. Dynamic, because
// this entry is eager and the kit must stay off the startup path.
const JiraSettingsTab = lazy(() =>
  Promise.all([
    import("./components/JiraSettingsTab"),
    import("@daintreehq/plugin-ui").then((kit) => kit.whenPluginUiReady()),
  ]).then(([m]) => ({ default: m.JiraSettingsTab }))
);

// The ids must match the manifest's `slots` values exactly. The project key is a
// project setting, so the host's own form edits it.
registerBuiltinView("jira.forgeSettingsTab", JiraSettingsTab, { pluginId: "daintree.jira" });
registerBuiltinView("jira.providerIcon", JiraIcon, { pluginId: "daintree.jira" });
