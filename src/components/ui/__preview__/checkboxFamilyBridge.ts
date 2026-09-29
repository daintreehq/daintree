// The app's Trusted Types policies: the dev CSP requires them, and Radix Select
// writes an inline <style> through `innerHTML`.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { BranchInfo, WorktreeChanges } from "@shared/types/git";

/**
 * The bridge calls the checkbox-family harness's heavier surfaces make, answered
 * from fixtures. Imported FIRST by `checkboxFamilyPreview.tsx` so the shim exists
 * before any client module reads `window.electron` at evaluation time. Every name
 * not answered here still degrades to the inert shim.
 *
 * What each answer is for:
 *   worktreePort   the delete dialog's open-time fresh status: two tracked edits,
 *                  so "Force delete" carries its "Required to delete…" sub-line
 *   worktree       the new-worktree dialog's branch list; `?state=on` makes the
 *                  remote branch the default, so "Create from remote branch"
 *                  starts checked
 *   forge          a resolved provider with an issue-selector slot and a viewer,
 *                  so the new-worktree dialog shows its Issue row and the
 *                  "Assign to @user" toggle
 *   plugin         the runtime snapshot that lets the GitHub issue selector
 *                  resolve, and the sideloaded plugin the manager offers to
 *                  uninstall
 */

export const PREVIEW_ROOT = "/Users/you/Code/helios-dashboard";
export const DELETE_WORKTREE_ID =
  "/Users/you/Code/helios-dashboard-worktrees/feature-retry-backoff";

const FRESH_CHANGES: WorktreeChanges = {
  worktreeId: DELETE_WORKTREE_ID,
  rootPath: DELETE_WORKTREE_ID,
  changes: [
    {
      path: `${DELETE_WORKTREE_ID}/src/net/retryBackoff.ts`,
      status: "modified",
      insertions: 24,
      deletions: 6,
    },
    {
      path: `${DELETE_WORKTREE_ID}/src/net/__tests__/retryBackoff.test.ts`,
      status: "modified",
      insertions: 41,
      deletions: 0,
    },
  ],
  changedFileCount: 2,
};

// `?state=on` makes the remote branch the default base, so the dialog opens with
// "Create from remote branch" checked; otherwise it opens unchecked.
const remoteDefault = new URLSearchParams(window.location.search).get("state") === "on";

const BRANCHES: BranchInfo[] = [
  { name: "develop", current: !remoteDefault, commit: "e69ea2c" },
  { name: "main", current: false, commit: "4b1d0aa" },
  { name: "origin/develop", current: remoteDefault, commit: "e69ea2c", remote: "origin" },
  { name: "origin/main", current: false, commit: "4b1d0aa", remote: "origin" },
];

const GITHUB_CONTRIBUTION = {
  id: "github",
  name: "GitHub",
  hostnames: ["github.com"],
  capabilities: ["issues", "pulls", "assignees", "identity"],
  slots: { issueSelector: "github.issueSelector" },
};

const CONTRIBUTES = {
  panels: [],
  toolbarButtons: [],
  menuItems: [],
  commands: [],
  views: [],
  mcpServers: [],
  skills: [],
  keybindings: [],
  contextMenus: [],
  forgeProviders: [],
  fileDecorationProviders: [],
  fileEditors: [],
  agents: [],
  processTools: [],
  recipes: [],
};

function plugin(over: Record<string, unknown>) {
  return {
    origin: "global",
    projectId: null,
    loadedAt: 1,
    isBuiltin: false,
    disabled: false,
    pendingRestart: false,
    source: "sideload",
    installedAt: Date.parse("2026-08-14T10:00:00Z"),
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: false,
    ...over,
  };
}

const PLUGINS = [
  plugin({
    instanceId: "daintree.github",
    isBuiltin: true,
    source: "builtin",
    installedAt: 0,
    dir: "/Applications/Daintree.app/Contents/Resources/plugins/github",
    manifest: {
      name: "daintree.github",
      version: "1.0.0",
      displayName: "GitHub",
      description: "Pull requests, issues and CI for GitHub repositories",
      contributes: CONTRIBUTES,
    },
  }),
  plugin({
    instanceId: "helios.linear-sync",
    dir: "/Users/you/Library/Application Support/Daintree/plugins/helios.linear-sync",
    manifest: {
      name: "helios.linear-sync",
      version: "2.4.0",
      displayName: "Linear Sync",
      description: "Links worktrees to Linear issues and keeps their state in step",
      contributes: CONTRIBUTES,
    },
  }),
];

/** Awaitable AND callable, like the base shim's answer: a request or an unsubscribe. */
function inert(): unknown {
  const settled = Promise.resolve(undefined);
  return Object.assign(() => undefined, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

/** A namespace whose named methods answer for real and whose others stay inert. */
function partial(methods: Record<string, unknown>): unknown {
  return new Proxy(methods, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => inert()),
  });
}

const unsubscribe = () => () => undefined;

installPreviewShims({
  worktreePort: partial({
    request: async (channel: string) => {
      if (channel === "get-worktree-changes") return { changes: FRESH_CHANGES };
      if (channel === "get-submodule-delete-risk") {
        // A completed, clean inventory: `null` reads as unverified and blocks the delete.
        return {
          risk: {
            entries: [],
            dirtyFiles: [],
            untrackedFiles: [],
            atRiskCommits: [],
            requiresMechanicalForce: false,
            incomplete: false,
          },
        };
      }
      if (channel === "get-delete-teardown-preview") return { preview: null };
      return {};
    },
  }),
  devPreview: partial({ getByWorktree: async () => null }),
  worktree: partial({
    listBranches: async () => BRANCHES,
    getRecentBranches: async () => ["develop", "main"],
    getAvailableBranch: async (_root: string, name: string) => name,
    getDefaultPath: async (_root: string, name: string) =>
      `/Users/you/Code/helios-dashboard-worktrees/${name.replace(/[^a-zA-Z0-9-_]/g, "-")}`,
  }),
  forge: partial({
    resolveProvider: async () => ({
      entry: { pluginId: "daintree.github", contribution: GITHUB_CONTRIBUTION },
      resolvedVia: "hostname",
    }),
    getCurrentUser: async () => ({ login: "mira-okafor", avatarUrl: "", rawData: null }),
    onRemoteChanged: unsubscribe,
  }),
  project: partial({
    getSettings: async () => ({ runCommands: [] }),
  }),
  plugin: partial({
    list: async () => PLUGINS,
    contextMenuItems: async () => [],
    onProvenanceChanged: unsubscribe,
    onInstallProgress: unsubscribe,
    checkForUpdate: async () => ({ status: "up-to-date" }),
  }),
});
