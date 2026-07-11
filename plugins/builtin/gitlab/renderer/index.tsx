import { lazy } from "react";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { GitLabIcon } from "@/components/icons/brands";

const GitLabSettingsTab = lazy(() =>
  import("./components/GitLabSettingsTab").then((m) => ({ default: m.GitLabSettingsTab }))
);

// Registration stays synchronous while the settings view loads only when
// rendered. The ids must match the manifest's `slots` values exactly.
registerBuiltinView("gitlab.forgeSettingsTab", GitLabSettingsTab, {
  pluginId: "daintree.gitlab",
});
registerBuiltinView("gitlab.providerIcon", GitLabIcon, { pluginId: "daintree.gitlab" });
