import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { emptyChipCounts, type ChipCounts } from "@/lib/worktreeFilters";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { WorktreeFilterPopover } from "../WorktreeFilterPopover";
import "@/index.css";

/**
 * Standalone visual-review harness for the worktree filter popover.
 *
 * Renders the REAL `WorktreeFilterPopover` in its sidebar configuration
 * (`appearance="field"`, no search input) against the real theme tokens and
 * `index.css`, with chip counts and store filters seeded from a fixture. The
 * harness opens it by clicking the trigger, as a user does, so focus lands the
 * way it does in the app. The worktree rows beside it are harness decoration.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|namib   built-in theme id
 *   ?fixture=<name>               one of FIXTURE_NAMES below
 */

interface Fixture {
  counts: ChipCounts;
  seed?: (store: ReturnType<typeof useWorktreeFilterStore.getState>) => void;
}

function counts(): ChipCounts {
  const c = emptyChipCounts();
  c.status = { active: 0, dirty: 2, stale: 0, idle: 4 };
  c.branchType.main = 1;
  c.branchType.other = 5;
  c.prIssue = { hasIssue: 3, hasPR: 2, prOpen: 2, prMerged: 0, prClosed: 0 };
  c.sessions = { hasTerminals: 4, working: 1, waiting: 1, completed: 2, exited: 0 };
  c.activity = { last15m: 1, last1h: 2, last24h: 4, last7d: 6 };
  c.devServer = { hasDevServer: 1, running: 1, starting: 0, error: 0 };
  return c;
}

const FIXTURES: Record<string, Fixture> = {
  /** The owner's screenshot: nothing filtered, Status and Branch type open. */
  default: { counts: counts() },
  /** A filter in two facets — Clear links and the footer are live. */
  active: {
    counts: counts(),
    seed: (s) => {
      s.toggleStatusFilter("dirty");
      s.toggleTypeFilter("main");
    },
  },
  /** Many branch types in use, so the chip grid wraps to several rows. */
  busy: {
    counts: (() => {
      const c = counts();
      Object.assign(c.branchType, { feature: 7, bugfix: 3, chore: 2, docs: 1, deps: 4, wip: 1 });
      return c;
    })(),
  },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "default";
const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(`unknown fixture "${fixtureName}" — one of ${FIXTURE_NAMES.join(", ")}`);
}

try {
  window.localStorage.clear();
} catch {
  // storage blocked — the store falls back to its defaults either way
}
const store = useWorktreeFilterStore.getState();
store.clearAll();
store.setOrderBy("recent");
store.setGroupByType(false);
fixture.seed?.(useWorktreeFilterStore.getState());

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function Rows() {
  return (
    <div data-harness-decoration aria-hidden="true" className="flex flex-col gap-1 px-3 py-2">
      {["main", "design-sidebar-filter", "issue-12488-handback", "feature/plugin-hosted-mcps"].map(
        (name) => (
          <div
            key={name}
            className="flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5"
          >
            <span className="h-4 w-4 shrink-0 rounded-[var(--radius-sm)] bg-overlay-medium" />
            <span className="truncate text-xs text-text-secondary">{name}</span>
          </div>
        )
      )}
    </div>
  );
}

function Preview() {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-preview-shell
      className="flex flex-col surface-sidebar"
      style={{ width: 320, height: 760 }}
    >
      <div className="flex items-stretch gap-1.5 px-3 pt-3 pb-3">
        <div className="h-7 flex-1 rounded-[var(--radius-md)] border border-border-default" />
        <WorktreeFilterPopover
          appearance="field"
          hideSearchInput
          chipCounts={fixture!.counts}
          open={open}
          onOpenChange={setOpen}
        />
      </div>
      <Rows />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
