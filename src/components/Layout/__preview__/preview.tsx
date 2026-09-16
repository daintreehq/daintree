import { FROZEN_NOW } from "./bootstrap";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { usePanelStore } from "@/store/panelStore";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { TrashedTerminal, TrashedTerminalGroupMetadata } from "@/store/slices";
import { TrashContainer } from "../TrashContainer";
import "@/index.css";

/**
 * Standalone visual-review harness for the "Recently closed" trash popover.
 *
 * The real surface is unphotographable: every row is destroyed twenty seconds
 * after it appears (`TRASH_TTL_MS`), so reaching a given state means closing
 * panes and racing a stopwatch, and the states that carry the most design
 * weight — the final five seconds, a list long enough to scroll, a tab group
 * beside an orphaned pane — are the ones hardest to hold still. This mounts
 * the real `TrashContainer` with the real `TrashBinItem` / `TrashGroupItem`
 * against the real theme tokens and `index.css`, with wall-clock time frozen
 * (see `bootstrap.ts`) so each fixture holds exactly the remaining-time it
 * declares.
 *
 * Nothing about the components is mocked, so a shot is evidence about
 * shipping code. What is a stand-in: the toolbar strip the pill sits in.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_TRASH=1 npx playwright test --project=screenshots trash-review
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=rest             which trash contents to render (see FIXTURES)
 *   ?width=1100               frame width in CSS px
 *   ?compact=1                the narrow pill variant
 */

const WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: "/Users/greg/Projects/daintree",
    name: "main",
    branch: "develop",
    isCurrent: true,
    isMainWorktree: true,
  },
  {
    id: "wt-12383",
    worktreeId: "wt-12383",
    path: "/Users/greg/Projects/daintree-worktrees/issue-12383",
    name: "issue-12383",
    branch: "bugfix/issue-12383-menu-rows-show-keyboard-focus",
    isCurrent: false,
  },
  {
    id: "wt-thumbs",
    worktreeId: "wt-thumbs",
    path: "/Users/greg/Projects/daintree-worktrees/thumbnails",
    name: "Thumbnails",
    branch: "feature/thumbnails",
    isCurrent: false,
  },
];

/** `PtyPanelData` pins `kind` to "terminal"; a fixture needs the other kinds too. */
type PaneOverrides = Omit<Partial<PtyPanelData>, "kind"> & { kind?: PanelInstance["kind"] };

function pane(id: string, title: string, extra: PaneOverrides = {}): PanelInstance {
  return {
    id,
    title,
    kind: "terminal" as PanelInstance["kind"],
    cwd: "/Users/greg/Projects/daintree",
    cols: 120,
    rows: 40,
    worktreeId: "wt-thumbs",
    projectId: "proj-daintree",
    location: "trash",
    hasPty: true,
    ...extra,
  } as PanelInstance;
}

/** Seconds of TTL left, turned into the absolute timestamp the row reads. */
function trashed(id: string, secondsLeft: number, extra: Partial<TrashedTerminal> = {}) {
  return {
    id,
    expiresAt: FROZEN_NOW + secondsLeft * 1000,
    originalLocation: "grid",
    ...extra,
  } satisfies TrashedTerminal;
}

type Entry = { terminal: PanelInstance; trashedInfo: TrashedTerminal };

function single(
  id: string,
  title: string,
  secondsLeft: number,
  paneExtra: PaneOverrides = {}
): Entry {
  return { terminal: pane(id, title, paneExtra), trashedInfo: trashed(id, secondsLeft) };
}

/** A tab group trashed as one unit — every member carries the same metadata. */
function group(
  restoreId: string,
  members: Array<{ id: string; title: string; secondsLeft: number }>,
  worktreeId: string | null = "wt-thumbs"
): Entry[] {
  const metadata: TrashedTerminalGroupMetadata = {
    panelIds: members.map((m) => m.id),
    activeTabId: members[0]!.id,
    location: "grid",
    worktreeId,
  };
  return members.map((m) => ({
    terminal: pane(m.id, m.title, { worktreeId: worktreeId ?? undefined }),
    trashedInfo: trashed(m.id, m.secondsLeft, {
      groupRestoreId: restoreId,
      groupMetadata: metadata,
    }),
  }));
}

const CODEX = { launchAgentId: "codex", detectedAgentId: "codex" } as const;
const CLAUDE = { launchAgentId: "claude", detectedAgentId: "claude" } as const;
const GEMINI = { launchAgentId: "gemini", detectedAgentId: "gemini" } as const;

const FIXTURES: Record<string, { what: string; entries: Entry[] }> = {
  rest: {
    what: "the reported state — two agent panes, fresh and mid-window",
    entries: [
      single("t-1", "Codex", 18, { ...CODEX, lastObservedTitle: "Codex" }),
      single("t-2", "Files — main", 11, { kind: "file-browser", worktreeId: "wt-main" }),
    ],
  },
  spread: {
    what: "four rows spanning the whole window — 19s down to 3s",
    entries: [
      single("t-1", "Codex", 19, CODEX),
      single("t-2", "Rebase onto develop", 13, CLAUDE),
      single("t-3", "Files — main", 8, { kind: "file-browser", worktreeId: "wt-main" }),
      single("t-4", "zsh", 3, { worktreeId: "wt-main" }),
    ],
  },
  single: {
    what: "one row, most of the window left",
    entries: [single("t-1", "Codex", 16, CODEX)],
  },
  critical: {
    what: "every row inside the final five seconds",
    entries: [
      single("t-1", "Codex", 5, CODEX),
      single("t-2", "Rebase onto develop", 3, CLAUDE),
      single("t-3", "zsh", 1, { worktreeId: "wt-main" }),
    ],
  },
  many: {
    what: "eight rows — the list scrolls at its 300px cap",
    entries: [
      single("t-1", "Codex", 19, CODEX),
      single("t-2", "Rebase onto develop", 17, CLAUDE),
      single("t-3", "Files — main", 15, { kind: "file-browser", worktreeId: "wt-main" }),
      single("t-4", "Fix the flaky pty-host test", 12, CLAUDE),
      single("t-5", "Review hub", 9, { kind: "review", worktreeId: "wt-main" }),
      single("t-6", "zsh", 7, { worktreeId: "wt-main" }),
      single("t-7", "Theme text ramp", 4, GEMINI),
      single("t-8", "Import budget ratchet", 2, CODEX),
    ],
  },
  grouped: {
    what: "a trashed tab group beside two singles",
    entries: [
      ...group("g-1", [
        { id: "g-1a", title: "Codex", secondsLeft: 14 },
        { id: "g-1b", title: "npm test", secondsLeft: 14 },
        { id: "g-1c", title: "Files — thumbnails", secondsLeft: 14 },
      ]),
      single("t-1", "Rebase onto develop", 9, CLAUDE),
      single("t-2", "zsh", 4, { worktreeId: "wt-main" }),
    ],
  },
  orphan: {
    what: "a pane whose worktree was deleted, beside a normal row",
    entries: [
      single("t-1", "Codex", 15, { ...CODEX, worktreeId: "wt-deleted" }),
      single("t-2", "Rebase onto develop", 6, CLAUDE),
    ],
  },
  "long-title": {
    what: "width pressure — a long agent task and a long worktree name",
    entries: [
      single(
        "t-1",
        "Stop menu rows from showing a keyboard focus ring on mouse hover (#12383)",
        16,
        { ...CLAUDE, worktreeId: "wt-12383" }
      ),
      single("t-2", "Regenerate the text-ramp manifest after the rebase lands", 7, {
        ...CODEX,
        worktreeId: "wt-12383",
      }),
    ],
  },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "rest";
const width = Number(params.get("width")) || 1100;
const compact = params.get("compact") === "1";

const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(`unknown fixture "${fixtureName}" — expected one of ${FIXTURE_NAMES.join(", ")}`);
}
const entries = fixture.entries;

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const worktreeStore = createWorktreeStore();
worktreeStore.setState({ worktrees: new Map(WORKTREES.map((w) => [w.id, w])) });
setCurrentViewStore(worktreeStore);

// Seeded before the first render so no row ever sees an empty store and then
// transitions — the harness photographs a state, not an arrival.
useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-thumbs" });
usePanelStore.setState({
  panelsById: Object.fromEntries(entries.map((e) => [e.terminal.id, e.terminal])),
  panelIds: entries.map((e) => e.terminal.id),
});

/**
 * The bottom toolbar strip the pill lives in. A stand-in, not the app's — but
 * the popover opens upward off this edge, so its anchor has to be in the right
 * place for the shot to mean anything.
 */
function Frame() {
  return (
    <div
      data-preview-shell
      data-fixture={fixtureName}
      className="flex flex-col justify-end bg-surface-canvas"
      style={{ width: `${width}px`, height: "560px" }}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-divider bg-surface-toolbar px-3">
        <div
          data-harness-decoration
          aria-hidden="true"
          className="h-2 w-16 rounded-full bg-overlay-soft"
        />
        <div
          data-harness-decoration
          aria-hidden="true"
          className="h-2 w-24 rounded-full bg-overlay-soft"
        />
        <div className="ml-auto flex items-center gap-2">
          <TrashContainer trashedTerminals={entries} compact={compact} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <Frame />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  </StrictMode>
);
