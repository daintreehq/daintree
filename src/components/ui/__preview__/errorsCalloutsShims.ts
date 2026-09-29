import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { PrerequisiteSpec } from "@shared/types";

/**
 * Bridge answers for the errors-and-callouts harness.
 *
 * Imported FIRST by `errorsCalloutsPreview.tsx`, so `window.electron` exists
 * before any store or client module evaluates. Every answer here is a failure
 * the product already handles — a rejected read, a failed install, a missing
 * tool — so what lands on screen is the component's own error path, not a
 * picture of one.
 */

const params = new URLSearchParams(window.location.search);
export const previewState = params.get("state") ?? "worktree-banners";

function inertMethod(): unknown {
  const settled = Promise.resolve(undefined);
  return Object.assign(() => undefined, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

function withInertFallback<T extends object>(target: T): T {
  return new Proxy(target, {
    get: (obj, key) => (key in obj ? Reflect.get(obj, key) : inertMethod),
  });
}

/** Resolves on a later tick, as a real IPC round trip does. */
function later<T>(value: T, ms = 30): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function failLater(message: string, ms = 30): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

export const MCP_PLUGIN_ID = "helios.linear-sync";
export const MCP_LIST_ERROR = "plugin-mcp:list timed out after 5000ms";
export const MCP_CRASH_ERROR =
  "Server exited with code 1 before the handshake: Error: LINEAR_API_KEY is not set";
export const MCP_RESTART_ERROR = "Plugin helios.linear-sync was unloaded while restarting";

/**
 * The supervisor snapshot answers for real until the preview flips this, then
 * every later poll rejects — so one section shows the crashed row it loaded AND
 * the section error a failed re-poll leaves under it.
 */
export const mcpShot = { listFails: false };

export const HEALTH_ERROR = "system:get-health-check-specs timed out after 10000ms";

/**
 * Two health-check sections share this one bridge. The first mounts while specs
 * reject; the preview flips this before mounting the second, which then reads
 * a real spec list with a missing and an outdated fatal tool.
 */
export const healthShot = { specsFail: true };

const PREREQUISITES: PrerequisiteSpec[] = [
  {
    tool: "git",
    label: "Git",
    versionArgs: ["--version"],
    severity: "fatal",
    installUrl: "https://git-scm.com/downloads",
    installBlocks: {
      macos: [{ label: "Homebrew", commands: ["brew install git"] }],
    },
  },
  {
    tool: "node",
    label: "Node.js",
    versionArgs: ["--version"],
    severity: "fatal",
    minVersion: "18.0.0",
    installUrl: "https://nodejs.org",
  },
  { tool: "npm", label: "npm", versionArgs: ["--version"], severity: "warn" },
  { tool: "gh", label: "GitHub CLI", versionArgs: ["--version"], severity: "warn" },
];

const TOOL_VERSIONS: Record<string, string | null> = {
  git: null,
  node: "16.20.2",
  npm: "10.9.2",
  gh: null,
};

export const LIFECYCLE_LOAD_ERROR =
  "Couldn't read .daintree/lifecycle.json: Unexpected token '}' at line 14, column 3";
export const BRANCH_LOAD_ERROR = "git branch -a exited with code 128: not a git repository";
export const INSTALL_ERROR =
  "plugin.json declares engine ^3.0.0, but this Daintree supports plugin API 2.x. Update Daintree or install an older version of the plugin.";

installPreviewShims({
  plugin: withInertFallback({
    installFromPath: () => later({ status: "failed", errors: [{ message: INSTALL_ERROR }] }, 120),
    getDiagnosticsSnapshot: () => later({ plugins: [] }),
  }),
  pluginMcp: withInertFallback({
    list: () => {
      if (mcpShot.listFails) return failLater(MCP_LIST_ERROR);
      return later([
        {
          pluginId: MCP_PLUGIN_ID,
          serverId: "linear",
          name: "Linear MCP",
          status: "crashed",
          pid: null,
          lastError: MCP_CRASH_ERROR,
          stderrLineCount: 0,
        },
        {
          pluginId: MCP_PLUGIN_ID,
          serverId: "search",
          name: "Issue search",
          status: "ready",
          pid: 48213,
          lastError: null,
          stderrLineCount: 0,
        },
      ]);
    },
    restart: () => failLater(MCP_RESTART_ERROR, 150),
    getStderr: () =>
      later({ pluginId: MCP_PLUGIN_ID, serverId: "linear", lines: [], totalLines: 0 }),
  }),
  system: withInertFallback({
    getHealthCheckSpecs: () =>
      healthShot.specsFail ? failLater(HEALTH_ERROR) : later(PREREQUISITES),
    checkTool: (spec: PrerequisiteSpec) => {
      const version = TOOL_VERSIONS[spec.tool] ?? null;
      const available = version !== null;
      return later({
        tool: spec.tool,
        label: spec.label,
        available,
        unavailableReason: available ? undefined : "not-found",
        version,
        severity: spec.severity,
        meetsMinVersion: available && spec.tool !== "node",
        minVersion: spec.minVersion,
        installUrl: spec.installUrl,
        installBlocks: spec.installBlocks,
      });
    },
    // The crash report's "Submit on GitHub" lands here and must fail.
    openExternal: () => failLater("No application is registered to open https:// URLs"),
    openPath: () => later(""),
    getHomeDir: () => later("/Users/you"),
  }),
  worktreePort: withInertFallback({
    request: (op: string) =>
      op === "get-lifecycle-command-approval" ? failLater(LIFECYCLE_LOAD_ERROR) : later(undefined),
  }),
  worktree: withInertFallback({
    listBranches: () =>
      previewState === "new-worktree-error"
        ? failLater(BRANCH_LOAD_ERROR)
        : later([
            { name: "main", current: true, commit: "4f2a9c1" },
            { name: "origin/main", current: false, commit: "4f2a9c1", remote: "origin" },
            { name: "develop", current: false, commit: "b81e0d3" },
          ]),
    getRecentBranches: () => later(["main", "develop"]),
    fetchPRBranch: () => failLater("fatal: couldn't find remote ref refs/pull/2481/head", 60),
    getDefaultPath: () => later("/Users/you/Code/helios-dashboard-worktrees/new-branch"),
  }),
  git: withInertFallback({
    listCommits: () => later({ items: [] }),
  }),
});

// A harness page must never inherit persisted state from the page before it.
try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
