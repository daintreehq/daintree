import { lazy } from "react";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { GitHubIcon } from "@/components/icons/brands";
import { GitHubStatsDropdown } from "./components/GitHubStatsDropdown";
import { useGitHubConfigStore } from "./stores/githubConfigStore";

const BulkCreateWorktreeDialog = lazy(() =>
  import("./components/BulkCreateWorktreeDialog").then((m) => ({
    default: m.BulkCreateWorktreeDialog,
  }))
);
const IssueSelector = lazy(() =>
  import("./components/IssueSelector").then((m) => ({ default: m.IssueSelector }))
);
const GitHubSettingsTab = lazy(() =>
  import("./components/GitHubSettingsTab").then((m) => ({ default: m.GitHubSettingsTab }))
);

// Registration stays synchronous while infrequently used views load only when rendered.
registerBuiltinView("github.bulkCreateWorktreeDialog", BulkCreateWorktreeDialog, {
  pluginId: "daintree.github",
  label: "Bulk worktree form",
});
registerBuiltinView("github.issueSelector", IssueSelector, {
  pluginId: "daintree.github",
  label: "Issue picker",
});
registerBuiltinView("github.forgeSettingsTab", GitHubSettingsTab, {
  pluginId: "daintree.github",
  label: "GitHub settings",
});
registerBuiltinView("github.providerIcon", GitHubIcon, {
  pluginId: "daintree.github",
  label: "GitHub icon",
});
registerBuiltinView("github.statsDropdown", GitHubStatsDropdown, {
  pluginId: "daintree.github",
  label: "GitHub list",
});

// E2E backdoor (gated on the preload-injected __DAINTREE_E2E_MODE__ flag, set
// only under DAINTREE_E2E_MODE=1 on non-packaged builds): refreshes the GitHub
// config store from the main process. Used by fault-mode tests to pick up a
// token seeded via __daintreeSeedGitHubToken so the no-token empty state
// doesn't short-circuit IPC fault paths. Lives in the plugin renderer so the
// host carries no reference to plugin-owned stores.
if (typeof window !== "undefined" && window.__DAINTREE_E2E_MODE__ === true) {
  window.__DAINTREE_E2E_REFRESH_GITHUB_CONFIG__ = () => useGitHubConfigStore.getState().refresh();
}
