// The app's Trusted Types policies: the dev CSP requires them, and Radix writes
// inline styles through `innerHTML`.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { BranchInfo } from "@shared/types/git";

/**
 * The bridge calls `NewWorktreeDialog` makes, answered from fixtures. Imported
 * FIRST by `newWorktree.tsx` so the shim exists before any client module reads
 * `window.electron`. Every name not answered here degrades to the inert shim.
 *
 * `?scenario=` picks how the bridge behaves:
 *   rest           a project with recipes, two environments and a forge
 *   issue          as rest; the page also opens on a linked issue
 *   pr             opened from a pull request whose head branch is on origin
 *   pr-unresolved  opened from a pull request whose head branch never arrives
 *   loading        the branch list never answers
 *   load-error     the branch list rejects
 *   bare           no forge, no recipes, no environments
 */

export const PREVIEW_ROOT = "/Users/you/Code/helios-dashboard";
export const PROJECT_ID = "proj-helios";

const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "rest";
export const SCENARIO = scenario;

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const BRANCHES: BranchInfo[] = [
  { name: "develop", current: true, commit: "e69ea2c", committerDate: ago(2 * 60 * 60 * 1000) },
  { name: "main", current: false, commit: "4b1d0aa", committerDate: ago(3 * DAY) },
  {
    name: "feature/streaming-uploads",
    current: false,
    commit: "9a01b2c",
    committerDate: ago(5 * DAY),
  },
  { name: "fix/retry-backoff-jitter", current: false, commit: "77c1d0e", committerDate: ago(DAY) },
  { name: "chore/bump-electron", current: false, commit: "1f2e3d4", committerDate: ago(9 * DAY) },
  { name: "release/v0.22.0", current: false, commit: "aa11bb2", committerDate: ago(20 * DAY) },
  {
    name: "origin/develop",
    current: false,
    commit: "e69ea2c",
    remote: "origin",
    committerDate: ago(2 * 60 * 60 * 1000),
  },
  {
    name: "origin/main",
    current: false,
    commit: "4b1d0aa",
    remote: "origin",
    committerDate: ago(3 * DAY),
  },
  {
    name: "origin/feature/dark-mode-tokens",
    current: false,
    commit: "c0ffee1",
    remote: "origin",
    committerDate: ago(4 * DAY),
  },
];

const GITHUB_CONTRIBUTION = {
  id: "github",
  name: "GitHub",
  hostnames: ["github.com"],
  capabilities: ["issues", "pulls", "assignees", "identity"],
  slots: { issueSelector: "github.issueSelector" },
};

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

/** The runtime snapshot the GitHub issue selector's slot resolves against. */
const GITHUB_PLUGIN = {
  instanceId: "daintree.github",
  origin: "global",
  projectId: null,
  loadedAt: 1,
  isBuiltin: true,
  disabled: false,
  pendingRestart: false,
  source: "builtin",
  installedAt: 0,
  archiveHash: null,
  originalUrl: null,
  loadError: null,
  updateAvailable: null,
  devMode: false,
  pluginDanger: "safe",
  blocklisted: false,
  dir: "/Applications/Daintree.app/Contents/Resources/plugins/github",
  manifest: {
    name: "daintree.github",
    version: "1.0.0",
    displayName: "GitHub",
    description: "Pull requests, issues and CI for GitHub repositories",
    contributes: CONTRIBUTES,
  },
};
const never = () => new Promise<never>(() => undefined);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hasForge = scenario !== "bare";
const hasSetup = scenario !== "bare";

installPreviewShims({
  worktree: partial({
    listBranches: async () => {
      if (scenario === "loading") return never();
      if (scenario === "load-error") {
        await delay(30);
        throw new Error("git branch --list exited with code 128: not a git repository");
      }
      return BRANCHES;
    },
    getRecentBranches: async () => ["develop", "fix/retry-backoff-jitter", "main"],
    getAvailableBranch: async (_root: string, name: string) => name,
    getDefaultPath: async (_root: string, name: string) =>
      `/Users/you/Code/helios-dashboard-worktrees/${name.replace(/[^a-zA-Z0-9-_]/g, "-")}`,
    fetchPRBranch: async () => {
      throw new Error("couldn't find remote ref refs/pull/12044/head");
    },
  }),
  forge: partial({
    resolveProvider: async () =>
      hasForge
        ? {
            entry: { pluginId: "daintree.github", contribution: GITHUB_CONTRIBUTION },
            resolvedVia: "hostname",
          }
        : { entry: null, resolvedVia: null },
    getCurrentUser: async () =>
      hasForge ? { login: "mira-okafor", avatarUrl: "", rawData: null } : null,
    listIssues: async () => ({ items: [], hasMore: false }),
    onRemoteChanged: unsubscribe,
  }),
  project: partial({
    getSettings: async () =>
      hasSetup
        ? {
            runCommands: [],
            defaultWorktreeRecipeId: "recipe-pair",
            resourceEnvironments: {
              staging: { provision: ["./scripts/env up staging"] },
              preview: { provision: ["./scripts/env up preview"] },
            },
          }
        : { runCommands: [] },
  }),
  git: partial({ getUsername: async () => "Mira Okafor" }),
  plugin: partial({
    list: async () => (hasForge ? [GITHUB_PLUGIN] : []),
    onProvenanceChanged: unsubscribe,
  }),
});
