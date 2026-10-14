// First: the bridge must exist before any client module reads it.
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import type {
  ProcessInventoryClosedProcess,
  ProcessInventorySnapshot,
  ProcessInventoryTerminal,
  ProcessTreeSample,
} from "@shared/types/processes";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProcessesDialog } from "@/components/Project/ProcessesDialog";
import "@/index.css";

/**
 * Visual-review harness for the running-processes dialog.
 *
 * Renders the product's own dialog with its snapshot and dev-preview session
 * reads answered from fixtures, against the real theme tokens.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?state=populated|empty|loading|degraded
 */

const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "populated";
const now = Date.now();
const MB = 1024;

function sample(
  cpuPercent: number,
  memoryMb: number,
  members: Array<[string, number]>,
  processCount = members.length
): ProcessTreeSample {
  return {
    cpuPercent,
    memoryKb: memoryMb * MB,
    processCount,
    members: members.map(([comm, mb], index) => ({
      pid: 40_000 + index,
      comm,
      cpuPercent: 0,
      memoryKb: mb * MB,
    })),
  };
}

function terminal(
  id: string,
  overrides: Partial<ProcessInventoryTerminal>
): ProcessInventoryTerminal {
  return {
    id,
    projectId: "helios",
    projectName: "helios-dashboard",
    kind: "terminal",
    cwd: "/Users/you/Code/helios-dashboard",
    isAssistantTerminal: false,
    spawnedAt: now - 3_600_000,
    isTrashed: false,
    rootPid: 51_200,
    sample: null,
    ...overrides,
  };
}

function closed(
  pid: number,
  comm: string,
  memoryMb: number | null,
  origin: ProcessInventoryClosedProcess["origin"],
  closedAgoMs: number,
  projectName: string | null
): ProcessInventoryClosedProcess {
  return {
    pid,
    startTime: `Tue Oct 14 09:${String(pid % 60).padStart(2, "0")}:00 2026`,
    comm,
    memoryKb: memoryMb === null ? null : memoryMb * MB,
    cpuPercent: null,
    origin,
    closedAt: now - closedAgoMs,
    projectName,
  } as ProcessInventoryClosedProcess;
}

const populated: ProcessInventorySnapshot = {
  terminals: [
    terminal("claude-main", {
      kind: "terminal",
      detectedAgentId: "claude",
      launchAgentId: "claude",
      title: "Claude — refactor the billing reconciliation worker",
      rootPid: 51_204,
      sample: sample(
        87,
        1_946,
        [
          ["claude", 1_100],
          ["node", 520],
          ["rg", 140],
          ["git", 60],
          ["zsh", 30],
          ["tsserver", 96],
        ],
        9
      ),
    }),
    terminal("dev-web", {
      kind: "dev-preview",
      title: "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort --config vite.config.preview.ts",
      rootPid: 51_377,
      sample: sample(12, 684, [
        ["node", 412],
        ["esbuild", 220],
        ["npm", 52],
      ]),
    }),
    terminal("shell-idle", {
      title: "zsh",
      rootPid: 51_402,
      sample: sample(0, 6, [["zsh", 6]]),
    }),
    terminal("trashed-tests", {
      title: "vitest --watch --coverage --reporter=verbose src/billing/reconciliation",
      isTrashed: true,
      trashExpiresAt: now + 23_400,
      rootPid: 51_588,
      sample: sample(
        34,
        412,
        [
          ["node", 280],
          ["vitest", 60],
          ["esbuild", 40],
          ["chokidar", 18],
          ["zsh", 14],
        ],
        11
      ),
    }),
    terminal("atlas-codex", {
      projectId: "atlas",
      projectName: "atlas-api",
      detectedAgentId: "codex",
      launchAgentId: "codex",
      title: "Codex",
      rootPid: 60_011,
      sample: sample(3, 238, [
        ["codex", 210],
        ["zsh", 28],
      ]),
    }),
    terminal("atlas-migrate", {
      projectId: "atlas",
      projectName: "atlas-api",
      title: "pnpm db:migrate --watch",
      rootPid: 60_142,
      sample: null,
    }),
    terminal("assistant", {
      projectId: null,
      projectName: null,
      isAssistantTerminal: true,
      title: undefined,
      rootPid: 70_001,
      sample: sample(1, 154, [["claude", 154]]),
    }),
  ],
  closedTerminalProcesses: [
    closed(
      62_010,
      "node",
      512,
      {
        kind: "terminal",
        id: "old-dev",
        projectId: "atlas",
        title: "npm run start:worker",
        spawnedAt: now - 7_200_000,
      },
      14 * 60_000,
      "atlas-api"
    ),
    closed(
      62_011,
      "esbuild",
      88,
      {
        kind: "terminal",
        id: "old-dev",
        projectId: "atlas",
        title: "npm run start:worker",
        spawnedAt: now - 7_200_000,
      },
      14 * 60_000,
      "atlas-api"
    ),
    closed(
      62_012,
      "chokidar",
      24,
      {
        kind: "terminal",
        id: "old-dev",
        projectId: "atlas",
        title: "npm run start:worker",
        spawnedAt: now - 7_200_000,
      },
      14 * 60_000,
      "atlas-api"
    ),
    closed(
      63_400,
      "python3",
      41,
      {
        kind: "terminal",
        id: "jupyter",
        projectId: "helios",
        title: "jupyter lab",
        spawnedAt: now - 9_000_000,
      },
      42_000,
      "helios-dashboard"
    ),
  ],
  cleanup: null,
  plugins: [
    {
      source: "plugin-worker",
      id: "github-worker",
      pluginId: "github",
      label: null,
      pid: 80_120,
      spawnedAt: null,
      sample: sample(0, 64, [["Daintree Helper", 64]]),
    },
    {
      source: "plugin-process",
      id: "linear-sync",
      pluginId: "linear-sync",
      label: "node",
      pid: 80_455,
      spawnedAt: now - 600_000,
      sample: sample(2, 118, [["node", 118]]),
    },
  ],
  complete: true,
  samplesAvailable: true,
  sampledAt: now,
};

const empty: ProcessInventorySnapshot = {
  terminals: [],
  closedTerminalProcesses: [],
  cleanup: null,
  plugins: [],
  complete: true,
  samplesAvailable: true,
  sampledAt: now,
};

const degraded: ProcessInventorySnapshot = {
  ...populated,
  complete: false,
  sampledAt: now - 26_000,
};

const sessions: DevPreviewSessionState[] = [
  {
    panelId: "panel-dev-web",
    projectId: "helios",
    status: "running",
    url: "http://localhost:5173",
    predictedUrl: null,
    error: null,
    terminalId: "dev-web",
    isRestarting: false,
    generation: 1,
    updatedAt: now,
  },
];

const never = <T,>() => new Promise<T>(() => {});

const snapshot =
  state === "empty" ? empty : state === "degraded" ? degraded : populated;

installPreviewShims({
  // The shim's thenable answers "cached" to `isViewCached`, which would stop
  // the dialog reading at all.
  app: new Proxy(
    { isViewCached: () => false },
    { get: (target, key) => (key in target ? Reflect.get(target, key) : () => () => undefined) }
  ),
  processes: {
    getSnapshot: () => (state === "loading" ? never() : Promise.resolve(snapshot)),
    killClosedTerminalProcesses: () => never(),
  },
  devPreview: new Proxy(
    { getAllSessions: () => Promise.resolve(sessions), stop: () => never() },
    { get: (target, key) => (key in target ? Reflect.get(target, key) : () => undefined) }
  ),
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell className="h-screen w-screen">
        <ProcessesDialog isOpen onClose={() => undefined} />
      </div>
    </TooltipProvider>
  </StrictMode>
);
