import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { GitHubIcon } from "@/components/icons/brands";
import { BulkCreateWorktreeDialog } from "./components/BulkCreateWorktreeDialog";
import { IssueSelector } from "./components/IssueSelector";
import { GitHubSettingsTab } from "./components/GitHubSettingsTab";
import { GitHubStatsDropdown } from "./components/GitHubStatsDropdown";
import { useGitHubConfigStore } from "./stores/githubConfigStore";

// Registration runs at module-load time. The host bootstrap imports this
// module once at app start so plugin slots are populated before any host
// dialog tries to resolve them. Slot ids stay dot-namespaced by plugin so
// future forge plugins can fill the same seams without colliding. The
// `pluginId` ties each slot to the daintree.github enable state — resolution
// returns null while the plugin is disabled, so these views drop out live.
registerBuiltinView("github.bulkCreateWorktreeDialog", BulkCreateWorktreeDialog, {
  pluginId: "daintree.github",
});
registerBuiltinView("github.issueSelector", IssueSelector, { pluginId: "daintree.github" });
registerBuiltinView("github.forgeSettingsTab", GitHubSettingsTab, {
  pluginId: "daintree.github",
});
registerBuiltinView("github.providerIcon", GitHubIcon, { pluginId: "daintree.github" });
registerBuiltinView("github.statsDropdown", GitHubStatsDropdown, {
  pluginId: "daintree.github",
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
