import "./installShims";
import { StrictMode, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { WorktreeSnapshot } from "@shared/types";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreContext, WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PopoverAnchor } from "@/components/ui/popover";
import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import { primeRadix } from "@/components/ui/radix-loader";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { Ellipsis } from "lucide-react";
import { MoveToWorktreePicker } from "../MoveToWorktreePicker";
import "@/index.css";

/**
 * Standalone visual-review harness for the "Move to worktree…" picker.
 *
 * Mounts the real `MoveToWorktreePicker` inside the real `AppPalettePopover`
 * root, hung off a stand-in for the pane header's overflow button, with the
 * per-view worktree store seeded from the fixture below. The names are the
 * point: several worktrees whose titles and branches share long prefixes, so
 * the rows have to tell apart things that only differ at the end.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?current=<worktree id>    the worktree the pane is in (default: hosts-history)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const currentId = params.get("current") ?? "hosts-history";

const ROOT = "/Users/dev/daintree";
const HOUR = 3_600_000;

function worktree(
  id: string,
  branch: string,
  extra: Partial<WorktreeSnapshot> = {}
): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `${ROOT}-worktrees/${branch.replace(/\//g, "-")}`,
    name: branch.slice(branch.lastIndexOf("/") + 1),
    branch,
    isCurrent: false,
    lastActivityTimestamp: Date.now() - HOUR,
    ...extra,
  } as WorktreeSnapshot;
}

const WORKTREES: WorktreeSnapshot[] = [
  worktree("main", "develop", { name: "daintree", path: ROOT, isMainWorktree: true }),
  worktree("hosts-exchanges", "feature/issue-13340-hosts-overview-exchanges", {
    issueNumber: 13340,
    issueTitle: "Hosts overview: show the exchanges between the hub and each host",
  }),
  worktree("hosts-exchanges-scroll", "feature/issue-13341-hosts-overview-exchanges-scroll", {
    issueNumber: 13341,
    issueTitle: "Hosts overview: keep the exchange thread pinned to the newest reply",
  }),
  worktree("hosts-history", "feature/issue-13336-hosts-overview-exchange-history", {
    issueNumber: 13336,
    issueTitle: "Hosts overview: page older exchanges in from the host's history",
  }),
  worktree("assistant-send", "feature/issue-13338-host-assistant-send-message", {
    issueNumber: 13338,
    issueTitle: "Let host assistants message the hub",
  }),
  worktree("restart-idle", "bugfix/remote-host-assistant-restart-on-idle-link-release"),
  worktree("restart-revoke", "bugfix/remote-host-assistant-restart-on-endpoint-close-revoke"),
  worktree("pr-exchanges", "feature/issue-13340-hosts-overview-exchanges-review", {
    sourcePrNumber: 13379,
    prTitle: "Hosts overview exchanges",
  }),
  worktree("palette-rows", "design/move-to-worktree-rows"),
];

/**
 * The per-view worktree store is created by the provider, so it is seeded from
 * inside the tree. The sidebar order is pinned to the fixture's order so a
 * capture never depends on the clock.
 */
function SeedWorktrees({ children }: { children: ReactNode }) {
  const store = use(WorktreeStoreContext);
  const [ready] = useState(() => {
    store?.setState({ worktrees: new Map(WORKTREES.map((wt) => [wt.id, wt])) });
    useWorktreeFilterStore.setState({
      orderBy: "manual",
      manualOrder: WORKTREES.map((wt) => wt.id),
      pinnedWorktrees: [],
      groupByType: false,
    });
    return true;
  });
  return ready ? children : null;
}

/**
 * A pane header at the width of a typical grid pane, with the overflow button
 * the picker hangs off at its end — the picker aligns its end edge to it, as it
 * does in the app.
 */
function Stage() {
  const [isOpen, setIsOpen] = useState(true);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="p-4" style={{ width: 880, height: 520 }}>
      <AppPalettePopover isOpen={isOpen} onOpenChange={setIsOpen} modal={true}>
        <div className="flex h-8 items-center gap-2 rounded-t-[var(--radius-md)] border border-divider bg-surface-panel px-2 text-xs text-text-secondary">
          <span className="min-w-0 flex-1 truncate">Claude: wire the exchange thread</span>
          <PopoverAnchor asChild>
            <button
              ref={anchorRef}
              type="button"
              aria-label="More panel actions"
              onClick={() => setIsOpen(true)}
              className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary"
            >
              <Ellipsis className="size-3.5" aria-hidden="true" />
            </button>
          </PopoverAnchor>
        </div>
        <MoveToWorktreePicker
          panelId="pane-under-review"
          currentWorktreeId={currentId}
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          returnFocusRef={anchorRef}
        />
      </AppPalettePopover>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    // A cold page can render a tooltip a frame before Radix reaches its
    // provider; load the primitives first.
    void primeRadix().then(() => setReady(true));
  }, [scheme]);

  if (!ready) return null;
  return (
    <SeedWorktrees>
      <Stage />
    </SeedWorktrees>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorktreeStoreProvider>
      <TooltipProvider delayDuration={300}>
        <App />
      </TooltipProvider>
    </WorktreeStoreProvider>
  </StrictMode>
);
