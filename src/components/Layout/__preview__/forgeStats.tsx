import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Bell, Settings } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import { ForgeStatsToolbarButton } from "../ForgeStatsToolbarButton";
import type { Project } from "@shared/types";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { ForgeRepositoryStats, ForgeRepoCountsUpdatedPayload } from "@shared/types/ipc/forge";
import { commitsFixture, listCommitsFrom, listPushCommitsFrom } from "./localCommitsFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the toolbar's forge stats control.
 *
 * Mounts the REAL `ForgeStatsToolbarButton` — its own width budget, its own
 * pills, indicators and freshness logic — with the bridge answering the three
 * reads it makes on mount (`project.getCurrent`, `forge.resolveProvider`,
 * `forge.getRepoStats`) from a fixture. Every other bridge name degrades to
 * inert. The states worth looking at (rate limited, token missing, a six-digit
 * commit history, PR detection paused) are ones a real session reaches rarely
 * and never on demand.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 *   ?fixture=<name>   one of FIXTURE_NAMES below
 *   ?commits=<name>   a history for the commits dropdown (`localCommitsFixtures.ts`);
 *                     without it the dropdown's reads stay inert
 *
 * `window.__forgePreviewPushCounts(issues, prs)` replays a background poll with
 * higher counts, which is the only road to the "new since last view" chips.
 */

const PROJECT_ID = "proj-daintree";
const PROJECT_PATH = "/Users/greg/Projects/daintree";
const PROVIDER_ID = "daintree.github.github";

const PROJECT: Project = {
  id: PROJECT_ID,
  path: PROJECT_PATH,
  name: "Daintree",
  emoji: "\u{1F333}",
  lastOpened: Date.now(),
};

const WORKTREE: WorktreeSnapshot = {
  id: "wt-main",
  worktreeId: "wt-main",
  path: PROJECT_PATH,
  name: "main",
  branch: "develop",
  isCurrent: true,
  isMainWorktree: true,
};

interface Fixture {
  what: string;
  /** `false` = no forge provider resolves, so the control is commits-only. */
  provider: boolean;
  /** `"pending"` = the stats read never settles (cold start). */
  stats: Partial<ForgeRepositoryStats> | "pending";
  prPaused?: boolean;
}

const minute = 60_000;

export const FIXTURES: Record<string, Fixture> = {
  default: {
    what: "the owner's screenshot — 7 issues, 6 PRs, 23,645 commits",
    provider: true,
    stats: { issueCount: 7, prCount: 6, commitCount: 23_645 },
  },
  small: {
    what: "a young repo — every count fits the budget",
    provider: true,
    stats: { issueCount: 12, prCount: 3, commitCount: 842 },
  },
  zero: {
    what: "nothing open — the zero treatment on two pills",
    provider: true,
    stats: { issueCount: 0, prCount: 0, commitCount: 1_204 },
  },
  large: {
    what: "a big public repo — four-digit issues, six-digit commits",
    provider: true,
    stats: { issueCount: 1_342, prCount: 87, commitCount: 128_904 },
  },
  "commits-only": {
    what: "no forge provider — the single commits pill",
    provider: false,
    stats: { issueCount: null, prCount: null, commitCount: 23_645 },
  },
  "token-error": {
    what: "provider resolved, token missing",
    provider: true,
    stats: {
      issueCount: null,
      prCount: null,
      commitCount: 23_645,
      error: "GitHub token not configured",
    },
  },
  "rate-limited": {
    what: "primary rate limit active — the clock slot is added",
    provider: true,
    stats: {
      issueCount: 7,
      prCount: 6,
      commitCount: 23_645,
      rateLimitResetAt: Date.now() + 14 * minute,
      rateLimitKind: "primary",
    },
  },
  "pr-paused": {
    what: "PR detection circuit breaker tripped — the paused glyph is added",
    provider: true,
    stats: { issueCount: 7, prCount: 6, commitCount: 23_645 },
    prPaused: true,
  },
  loading: {
    what: "cold start — the stats read has not answered yet",
    provider: true,
    stats: "pending",
  },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "default";
const baseFixture = FIXTURES[fixtureName];
if (!baseFixture) {
  throw new Error(`unknown fixture "${fixtureName}" — one of ${FIXTURE_NAMES.join(", ")}`);
}
const commits = commitsFixture(params.get("commits"));
const fixture: Fixture =
  commits?.commitCount !== undefined && baseFixture.stats !== "pending"
    ? { ...baseFixture, stats: { ...baseFixture.stats, commitCount: commits.commitCount } }
    : baseFixture;

function inert(): unknown {
  const settled = Promise.resolve(undefined);
  const fn = () => undefined;
  return Object.assign(fn, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

/** A namespace that answers `methods` for real and every other name inertly. */
function answering(methods: Record<string, unknown>): unknown {
  return new Proxy(methods, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => inert()),
  });
}

function fullStats(partial: Partial<ForgeRepositoryStats>): ForgeRepositoryStats {
  const now = Date.now();
  return {
    commitCount: 0,
    issueCount: null,
    prCount: null,
    loading: false,
    lastUpdated: now,
    issueCountRefreshedAt: now,
    prCountRefreshedAt: now,
    ...partial,
  };
}

let countsListener: ((payload: ForgeRepoCountsUpdatedPayload) => void) | null = null;

installPreviewShims({
  ...(commits
    ? {
        git: answering({
          listCommits: listCommitsFrom(commits),
          listPushCommits: listPushCommitsFrom(commits),
        }),
      }
    : {}),
  project: answering({
    getCurrent: async () => PROJECT,
    onStatsUpdated: () => () => undefined,
  }),
  forge: answering({
    resolveProvider: async () =>
      fixture.provider
        ? {
            entry: {
              pluginId: "daintree.github",
              contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
            },
            resolvedVia: "hostname",
          }
        : { entry: null, resolvedVia: null },
    getRepoStats: () =>
      fixture.stats === "pending"
        ? new Promise(() => undefined)
        : Promise.resolve(fullStats(fixture.stats)),
    getRepoUrl: async () => "https://github.com/daintreehq/daintree",
    getFirstPageCache: async () => null,
    onRepoCountsUpdated: (cb: (payload: ForgeRepoCountsUpdatedPayload) => void) => {
      countsListener = cb;
      return () => {
        countsListener = null;
      };
    },
  }),
});

Reflect.set(window, "__forgePreviewPushCounts", (issueCount: number, prCount: number) => {
  if (!countsListener || fixture.stats === "pending") return false;
  const now = Date.now() + 1_000;
  countsListener({
    providerId: PROVIDER_ID,
    projectPath: PROJECT_PATH,
    fetchedAt: now,
    stats: fullStats({
      ...fixture.stats,
      issueCount,
      prCount,
      lastUpdated: now,
      issueCountRefreshedAt: now,
      prCountRefreshedAt: now,
    }),
  });
  return true;
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

try {
  localStorage.clear();
} catch {
  // private mode — defaults apply
}
const worktreeStore = createWorktreeStore();
worktreeStore.setState({ worktrees: new Map([[WORKTREE.id, WORKTREE]]) });
setCurrentViewStore(worktreeStore);
useWorktreeSelectionStore.setState({ activeWorktreeId: WORKTREE.id });
useProjectStore.setState({ currentProject: PROJECT });
usePRCircuitBreakerStore.setState({ tripped: !!fixture.prPaused });

/**
 * A slice of the right toolbar group so the control is judged at the weight it
 * actually sits at: two real-sized icon buttons after it. Harness decoration.
 */
function Preview() {
  return (
    <div
      data-preview-shell
      className="surface-toolbar flex h-12 w-[560px] items-center justify-end gap-1.5 border-b border-divider px-4"
    >
      <div data-forge-region className="flex items-center">
        <ForgeStatsToolbarButton currentProject={PROJECT} />
      </div>
      <span
        data-harness-decoration
        aria-hidden="true"
        className="toolbar-icon-button relative flex h-8 w-8 items-center justify-center text-text-primary"
      >
        <Bell className="h-4 w-4" />
      </span>
      <span
        data-harness-decoration
        aria-hidden="true"
        className="toolbar-icon-button relative flex h-8 w-8 items-center justify-center text-text-primary"
      >
        <Settings className="h-4 w-4" />
      </span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorktreeStoreContext.Provider value={worktreeStore}>
      <TooltipProvider>
        <Preview />
      </TooltipProvider>
    </WorktreeStoreContext.Provider>
  </StrictMode>
);
