import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { BulkCreateWorktreeDialog } from "./components/BulkCreateWorktreeDialog";
import { IssueSelector } from "./components/IssueSelector";
import { GitHubSettingsTab } from "./components/GitHubSettingsTab";

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
