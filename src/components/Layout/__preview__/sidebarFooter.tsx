import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useKeepAwakeStore } from "@/store/keepAwakeStore";
import { usePanelStore } from "@/store/panelStore";
import { QuickRun } from "@/components/Project/QuickRun";
import { SidebarStatusBar } from "../SidebarStatusBar";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { RunCommand } from "@shared/types";
import "@/index.css";

/**
 * Standalone visual-review harness for the sidebar's bottom section.
 *
 * The footer is three strips that accreted separately — `QuickRun`, the
 * plugin indicator, and the `ProjectResourceBadge` status row — and they are
 * only ever seen stacked. Reviewing them one component at a time is how they
 * came to disagree about density, colour and type without anyone noticing.
 *
 * Booting Electron for this would be the wrong tool: most of the states worth
 * looking at are combinations of store values (a wake lock held, three
 * projects running, no worktree selected) that a real session reaches rarely
 * and never on demand. So this renders the REAL components against the real
 * theme tokens and the real `index.css`, in a 320px column — the sidebar's
 * canonical width — with the tree above stubbed as harness decoration so the
 * footer's weight can be judged against the chrome it actually sits under.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|namib   built-in theme id
 *   ?fixture=<name>               one of FIXTURE_NAMES below
 *   ?width=320                    sidebar width in CSS px
 *
 * Every fixture seeds stores BEFORE `createRoot().render()`. Seeding inside a
 * component body is a cross-component update React rightly complains about,
 * and both `QuickRun` and the badge read on their first render.
 */

const PROJECT_ID = "proj-daintree";

const WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: "/Users/greg/Projects/daintree",
    name: "main",
    branch: "develop",
    isCurrent: false,
    isMainWorktree: true,
  },
  {
    id: "wt-status-bar",
    worktreeId: "wt-status-bar",
    path: "/Users/greg/Projects/daintree-worktrees/design-status-bar",
    name: "design-status-bar",
    branch: "design/status-bar",
    isCurrent: true,
  },
];

/** A branch long enough to prove the header's truncation, not just assert it exists. */
const LONG_BRANCH: WorktreeSnapshot = {
  id: "wt-long",
  worktreeId: "wt-long",
  path: "/Users/greg/Projects/daintree-worktrees/issue-12488-handback",
  name: "feature/issue-12488-handback-marker-contract",
  branch: "feature/issue-12488-handback-marker-contract",
  isCurrent: true,
};

const DETECTED_RUNNERS: RunCommand[] = [
  { id: "r-dev", name: "dev", command: "npm run dev", description: "Main + Renderer (Vite)" },
  { id: "r-test", name: "test", command: "npm test", description: "vitest" },
  { id: "r-check", name: "check", command: "npm run check", description: "typecheck + guards" },
  { id: "r-build", name: "build", command: "npm run build", description: "production build" },
];

const SAVED_RUNNERS: RunCommand[] = [
  {
    id: "s-dev",
    name: "Dev server",
    command: "npm run dev",
    preferredLocation: "grid",
    preferredAutoRestart: true,
  },
];

/** `PtyPanelData` pins `kind`; a fixture needs to set the rest. */
function task(id: string, title: string, extra: Partial<PtyPanelData> = {}): PanelInstance {
  return {
    id,
    title,
    kind: "terminal",
    cwd: "/Users/greg/Projects/daintree-worktrees/design-status-bar",
    cols: 120,
    rows: 40,
    worktreeId: "wt-status-bar",
    projectId: PROJECT_ID,
    location: "dock",
    hasPty: true,
    spawnedBy: "quickrun",
    runtimeStatus: "running",
    startedAt: Date.now() - 92_000,
    ...extra,
  } as PanelInstance;
}

interface Fixture {
  /** One line on what this state is for, shown as the sheet label. */
  what: string;
  seed: () => void;
}

/** How many projects the badge should report as running, and the memory reading. */
function seedStats(runningProjects: number, totalMemoryMB: number): void {
  const projects = Array.from({ length: 4 }, (_, i) => ({
    id: `proj-${i}`,
    name: ["Daintree", "Assistant", "Backend", "Site builder"][i]!,
  }));
  const stats: Record<string, { processCount: number }> = {};
  projects.forEach((p, i) => {
    stats[p.id] = { processCount: i < runningProjects ? 2 : 0 };
  });
  useProjectStatsStore.setState({ stats: stats as never });
  PROJECT_LIST = projects;
  APP_MEMORY_MB = totalMemoryMB;
}

let PROJECT_LIST: Array<{ id: string; name: string }> = [];
let APP_MEMORY_MB = 1240;

/** Reset everything a fixture might have set, so one sweep can't leak into the next. */
function baseline(): void {
  try {
    localStorage.clear();
  } catch {
    // private mode — the defaults below still apply
  }
  const worktreeStore = createWorktreeStore();
  worktreeStore.setState({ worktrees: new Map(WORKTREES.map((w) => [w.id, w])) });
  setCurrentViewStore(worktreeStore);
  CURRENT_STORE = worktreeStore;

  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-status-bar" });
  useProjectStore.setState({ currentProject: { id: PROJECT_ID, name: "Daintree" } as never });
  useProjectSettingsStore.setState({
    projectId: PROJECT_ID,
    settings: { runCommands: SAVED_RUNNERS },
    detectedRunners: DETECTED_RUNNERS,
    allDetectedRunners: DETECTED_RUNNERS,
    isLoading: false,
    error: null,
  });
  usePanelStore.setState({ panelsById: new Map(), panelIds: [] } as never);
  useKeepAwakeStore.setState({
    visible: true,
    state: { isBlocking: true, revision: 1 } as never,
    loadError: null,
  });
  seedStats(1, 1240);
}

let CURRENT_STORE = createWorktreeStore();

export const FIXTURES: Record<string, Fixture> = {
  /** What the owner sees almost all of the time. */
  default: {
    what: "one project running, a wake lock held, nothing typed",
    seed: baseline,
  },

  /** The wake lock released — the strip's other everyday shape. */
  idle: {
    what: "no wake lock, one project running",
    seed: () => {
      baseline();
      useKeepAwakeStore.setState({ visible: false, state: null });
    },
  },

  /** Nothing running at all: the readout hides and the whole row should vanish. */
  "nothing-running": {
    what: "no projects running and no wake lock — the row should not render",
    seed: () => {
      baseline();
      useKeepAwakeStore.setState({ visible: false, state: null });
      seedStats(0, 380);
    },
  },

  /** Plural, and the count the popover is actually worth opening for. */
  "many-projects": {
    what: "four projects running, wake lock held",
    seed: () => {
      baseline();
      seedStats(4, 5120);
    },
  },

  /** Memory pressure — `memoryState` goes critical and drives the dot. */
  "memory-critical": {
    what: "four projects, memory reading high enough to trip the critical state",
    seed: () => {
      baseline();
      seedStats(4, 24_000);
    },
  },

  /** The state the owner says he wants: QuickRun folded away. */
  collapsed: {
    what: "QuickRun collapsed to its header",
    seed: baseline,
  },

  /** Both toggles lit, so their active treatment can be compared to their rest one. */
  "toggles-active": {
    what: "auto-restart on, output set to Dock",
    seed: () => {
      baseline();
      try {
        localStorage.setItem(`daintree_quickrun_autorestart_${PROJECT_ID}`, "true");
      } catch {
        // defaults to off, which the fixture label will contradict — acceptable
      }
    },
  },

  /** No worktree selected: QuickRun swaps the input for a sentence. */
  "no-worktree": {
    what: "no active worktree — QuickRun cannot run anything",
    seed: () => {
      baseline();
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    },
  },

  /** The truncation case for the header's branch name. */
  "long-branch": {
    what: "a branch name far wider than the 320px column",
    seed: () => {
      baseline();
      const store = createWorktreeStore();
      store.setState({ worktrees: new Map([[LONG_BRANCH.id, LONG_BRANCH]]) });
      setCurrentViewStore(store);
      CURRENT_STORE = store;
      useWorktreeSelectionStore.setState({ activeWorktreeId: LONG_BRANCH.id });
    },
  },

  /** Tasks running under QuickRun push the input down and add their own rows. */
  "running-tasks": {
    what: "two QuickRun tasks running above the input",
    seed: () => {
      baseline();
      const panels = [
        task("t-dev", "npm run dev"),
        task("t-test", "npm test", {
          runtimeStatus: "exited",
          exitCode: 1,
          startedAt: Date.now() - 41_000,
        }),
      ];
      usePanelStore.setState({
        panelsById: new Map(panels.map((p) => [p.id, p])),
        panelIds: panels.map((p) => p.id),
      } as never);
    },
  },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "320");
const fixtureName = params.get("fixture") ?? "default";

const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(`unknown fixture "${fixtureName}" — one of ${FIXTURE_NAMES.join(", ")}`);
}

/**
 * The badge reaches for two real reads on mount and renders nothing useful
 * without them, so these two namespaces answer for real while every other name
 * still degrades to inert.
 *
 * Each override is itself a Proxy: `installPreviewShims` hands back the
 * override object wholesale for a namespace it knows, so a bare object literal
 * would return `undefined` for every sibling method the component also calls,
 * which is the blank-harness failure the shim exists to prevent.
 */
function answering(methods: Record<string, unknown>): unknown {
  const inert = () => {
    const settled = Promise.resolve(undefined);
    const fn = () => undefined;
    return Object.assign(fn, {
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    });
  };
  return new Proxy(methods, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => inert()),
  });
}

installPreviewShims({
  project: answering({
    getAll: async () => PROJECT_LIST,
    getSettings: async () => ({ runCommands: SAVED_RUNNERS }),
    detectRunners: async () => DETECTED_RUNNERS,
    onStatsUpdated: () => () => undefined,
  }),
  system: answering({
    getAppMetrics: async () => ({
      unavailable: false,
      totalMemoryMB: APP_MEMORY_MB,
      processes: [],
    }),
    getHardwareInfo: async () => ({ totalMemoryBytes: 64 * 1024 ** 3 }),
    getDiagnostics: async () => ({
      uptimeSeconds: 7_400,
      eventLoopP99Ms: 12,
      systemAvailableMB: 18_400,
    }),
  }),
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

fixture.seed();

/**
 * The bottom of the tree, drawn so the footer has the density it actually
 * butts against. Harness decoration — not the app's sidebar.
 */
function TreeTail() {
  const rows = ["main", "design-status-bar", "issue-12488-handback"];
  return (
    <div data-harness-decoration aria-hidden="true" className="flex flex-col gap-1 px-3 pb-3 pt-4">
      {rows.map((name, i) => (
        <div
          key={name}
          className={`flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 ${
            i === 1 ? "bg-overlay-subtle" : ""
          }`}
        >
          <span className="h-4 w-4 shrink-0 rounded-[var(--radius-sm)] bg-overlay-medium" />
          <span className="truncate text-xs text-text-secondary">{name}</span>
        </div>
      ))}
    </div>
  );
}

function Preview() {
  return (
    <div
      data-preview-shell
      className="flex h-screen flex-col justify-end surface-sidebar"
      style={{ width: `${width}px` }}
    >
      <TreeTail />
      <div data-footer-region className="flex flex-col">
        <QuickRun projectId={PROJECT_ID} />
        <SidebarStatusBar />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={CURRENT_STORE}>
        <Preview />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  </StrictMode>
);
