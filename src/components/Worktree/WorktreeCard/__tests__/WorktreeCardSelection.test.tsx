/**
 * @vitest-environment jsdom
 *
 * The card is the button (#15864). Rendered against the real card, header,
 * disclosures, badges and click routing: every part of the card that is
 * content selects the worktree, every control does its own thing and never
 * selects, and nothing either way depends on which card is the active one.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import type { WorktreeState } from "@/types";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

const dispatch = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));

vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  worktreeClient: {
    refresh: vi.fn(() => Promise.resolve()),
    switchEnvironment: vi.fn(),
    attachmentAction: vi.fn(() => Promise.resolve()),
  },
  errorsClient: { retry: vi.fn(() => Promise.resolve()) },
}));

const SESSION: PtyPanelData = {
  id: "term-1",
  kind: "terminal",
  title: "Claude",
  worktreeId: "wt-1",
  location: "grid",
  hasPty: true,
  detectedAgentId: "claude",
  agentState: "working",
} as unknown as PtyPanelData;

let mockTerminals: PtyPanelData[] = [SESSION];
vi.mock("@/hooks/useWorktreeTerminals", () => ({
  useWorktreeTerminals: () => ({
    counts: {
      total: mockTerminals.length,
      byState: {
        idle: 0,
        working: mockTerminals.length,
        waiting: 0,
        directing: 0,
        completed: 0,
        exited: 0,
      },
      unread: 0,
    },
    terminals: mockTerminals,
    dominantAgentState: null,
  }),
}));

vi.mock("@/hooks/app/useWorktreeDevServerSession", () => ({
  useWorktreeDevServerSession: () => undefined,
}));

vi.mock("@/hooks/usePluginContextMenuItems", () => ({
  usePluginContextMenuItems: () => [],
}));

vi.mock("@/hooks/useForgeTooltip", () => {
  const tooltip = () => ({
    data: null,
    loading: false,
    error: false,
    missingCredential: false,
    providerId: "daintree.github.github",
    fetchTooltip: () => Promise.resolve(),
    reset: () => {},
  });
  return { useIssueTooltip: tooltip, usePRTooltip: tooltip };
});

vi.mock("@/hooks/useForgeAuthorAvatar", () => ({ useForgeAuthorAvatar: () => undefined }));
vi.mock("@/hooks/useReviewChangeHint", () => ({ useReviewChangeHint: () => null }));

// Each session row owns a TerminalContextMenu, which reads the worktree
// store; its scoping is pinned in its own suite.
vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// The card renders its dialogs inside its own tree and they portal to
// `document.body`, exactly as its menus and popovers do. The stand-in keeps
// that shape: whatever layer a test puts here is portalled from inside the
// card, so React bubbles its events through the card's handlers.
let renderDialogLayer: () => React.ReactNode = () => null;
vi.mock("../WorktreeDialogs", () => ({ WorktreeDialogs: () => renderDialogLayer() }));

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
    useReducedMotion: () => false,
  };
});

import { WorktreeCard } from "../../WorktreeCard";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";

const WORKTREE: WorktreeState = {
  id: "wt-1",
  worktreeId: "wt-1",
  path: "/repo/wt-1",
  name: "wt-1",
  branch: "feature/login",
  isCurrent: false,
  isMainWorktree: false,
  issueNumber: 42,
  issueTitle: "Fix the login flow",
  linked: {
    providerId: "github",
    pr: {
      ref: { providerId: "github", owner: "o", repo: "r", number: 101, rawData: null },
      title: "Fix the login flow",
      url: "https://github.com/o/r/pull/101",
      state: "open",
    },
  },
  worktreeChanges: {
    worktreeId: "wt-1",
    rootPath: "/repo/wt-1",
    changes: [
      { path: "src/a.ts", status: "modified", insertions: 10, deletions: 2 },
      { path: "src/b.ts", status: "modified", insertions: 1, deletions: 1 },
      { path: "src/c.ts", status: "modified", insertions: 1, deletions: 1 },
    ],
    changedFileCount: 3,
    insertions: 12,
    deletions: 4,
    lastCommitMessage: "Tighten the session check",
    lastCommitTimestampMs: Date.now() - 60_000,
  },
  lastActivityTimestamp: Date.now() - 60_000,
} as unknown as WorktreeState;

function renderCard({
  isActive,
  worktree = WORKTREE,
  deleteError,
  isDraggingSort,
}: {
  isActive: boolean;
  worktree?: WorktreeState;
  deleteError?: string;
  isDraggingSort?: boolean;
}) {
  const onSelect = vi.fn();
  const store = createWorktreeStore();
  // The card's handlers act on the current view's store, as they do in a
  // project view.
  setCurrentViewStore(store);
  if (deleteError) store.setState({ deleteErrors: new Map([[worktree.id, deleteError]]) });
  const utils = render(
    <WorktreeStoreContext.Provider value={store}>
      <TooltipProvider>
        <WorktreeCard
          worktree={worktree}
          isActive={isActive}
          isFocused={false}
          onSelect={onSelect}
          onOpenEditor={vi.fn()}
          isDraggingSort={isDraggingSort}
        />
      </TooltipProvider>
    </WorktreeStoreContext.Provider>
  );
  return { ...utils, onSelect };
}

function card(): HTMLElement {
  return document.querySelector<HTMLElement>(".sidebar-worktree-card")!;
}

function expanded() {
  const { expandedWorktrees, expandedTerminals } = useWorktreeSelectionStore.getState();
  return {
    details: expandedWorktrees.has(WORKTREE.id),
    sessions: expandedTerminals.has(WORKTREE.id),
  };
}

function detailsButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Details for worktree/ });
}

function sessionsButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Active sessions for worktree/ });
}

/** A real pointer click: `detail` counts presses, where Enter/Space give 0. */
function press(target: Element) {
  fireEvent.click(target, { detail: 1 });
}

function selectTextOf(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

beforeEach(() => {
  dispatch.mockClear();
  mockTerminals = [SESSION];
  renderDialogLayer = () => null;
  useFleetArmingStore.getState().clear();
  useWorktreeSelectionStore.setState({
    expandedWorktrees: new Set(),
    expandedTerminals: new Set(),
  });
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

describe.each(["comfortable", "compact"] as const)("WorktreeCard selection — %s", (density) => {
  beforeEach(() => {
    useWorktreeFilterStore.setState({ cardDensity: density, collapsedWorktrees: [] });
  });

  describe.each([
    ["inactive", false],
    ["active", true],
  ] as const)("on the %s card", (_label, isActive) => {
    const contentTargets: Array<[string, () => HTMLElement]> = [
      ["the title", () => screen.getByTestId("worktree-headline-title")],
      ["the branch", () => screen.getAllByText("feature/login")[0]!],
      ["the change summary", () => screen.getByText("3 files")],
      // A status mark: focusable for its tooltip, but content, not a control.
      ["the activity age", () => screen.getByRole("group", { name: "Last activity" })],
      ["the card's padding", () => card()],
    ];

    it.each(contentTargets)("a click on %s selects and opens nothing", (_name, target) => {
      const { onSelect } = renderCard({ isActive });
      press(target());
      // Re-selecting the active worktree is the store's no-op; what matters is
      // that content always answers as the card.
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(expanded()).toEqual({ details: false, sessions: false });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("a click on the commit line selects and opens nothing", () => {
      const clean = {
        ...WORKTREE,
        worktreeChanges: { ...WORKTREE.worktreeChanges!, changes: [], changedFileCount: 0 },
      } as WorktreeState;
      const { onSelect } = renderCard({ isActive, worktree: clean });
      press(screen.getByText(/Tighten the session check/));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(expanded()).toEqual({ details: false, sessions: false });
    });

    it("a click on the sessions count and agent glyph selects and opens nothing", () => {
      const { onSelect } = renderCard({ isActive });
      const summary = sessionsButton().nextElementSibling!;
      expect(summary.querySelector("svg")).not.toBeNull();
      expect(summary.textContent).toContain("1");
      press(summary);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(expanded()).toEqual({ details: false, sessions: false });
    });

    it("a PR headline is words that select, and its PR opens from its own reference", () => {
      const fromPr = { ...WORKTREE, sourcePrNumber: 101, issueNumber: undefined } as WorktreeState;
      const { onSelect } = renderCard({ isActive, worktree: fromPr });
      const title = screen.getByTestId("worktree-headline-title");
      expect(title.textContent).toBe("Fix the login flow");
      press(title);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();

      press(screen.getByRole("button", { name: /pull request #101/ }));
      expect(dispatch).toHaveBeenCalledWith(
        "worktree.openPR",
        { worktreeId: WORKTREE.id },
        { source: "user" }
      );
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("the plan file opens on the first click without selecting", () => {
      const withPlan = { ...WORKTREE, hasPlanFile: true, planFilePath: "TODO.md" } as WorktreeState;
      const { onSelect } = renderCard({ isActive, worktree: withPlan });
      press(screen.getByRole("button", { name: /^Open plan file TODO\.md for worktree/ }));
      expect(dispatch).toHaveBeenCalledWith(
        "file.view",
        expect.objectContaining({ path: "TODO.md", worktreeId: WORKTREE.id })
      );
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("a recovery banner's text and its actions never select", () => {
      const { onSelect } = renderCard({ isActive, deleteError: "fatal: worktree is locked" });
      press(screen.getByText("fatal: worktree is locked"));
      press(screen.getByTestId("worktree-delete-dismiss"));
      // Dismissing did its job: the banner is gone.
      expect(screen.queryByTestId("worktree-delete-error-banner")).toBeNull();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("the open session list is the arming surface, not the card", () => {
      useWorktreeSelectionStore.setState({ expandedTerminals: new Set([WORKTREE.id]) });
      const { onSelect } = renderCard({ isActive });
      // A marquee drag that ends over the list's own background clicks it.
      press(screen.getByRole("list"));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("the Details control toggles Details only, on the first click, as the same control", () => {
      const { onSelect } = renderCard({ isActive });
      const control = detailsButton();
      expect(control.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(control);
      expect(expanded()).toEqual({ details: true, sessions: false });
      expect(detailsButton()).toBe(control);
      expect(control.getAttribute("aria-expanded")).toBe("true");

      fireEvent.click(control);
      expect(expanded()).toEqual({ details: false, sessions: false });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("the Sessions control toggles Sessions only, on the first click, as the same control", () => {
      const { onSelect } = renderCard({ isActive });
      const control = sessionsButton();

      fireEvent.click(control);
      expect(expanded()).toEqual({ details: false, sessions: true });
      expect(sessionsButton()).toBe(control);

      fireEvent.click(control);
      expect(expanded()).toEqual({ details: false, sessions: false });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("the issue reference opens the issue and does not select", () => {
      const { onSelect } = renderCard({ isActive });
      const reference = screen.getByRole("button", { name: /^Open issue #42/ });
      expect(reference.getAttribute("aria-disabled")).toBeNull();
      expect(reference.getAttribute("aria-label")).toContain("for worktree");

      fireEvent.click(reference);
      expect(dispatch).toHaveBeenCalledWith(
        "worktree.openIssue",
        { worktreeId: WORKTREE.id },
        { source: "user" }
      );
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("the PR reference opens the PR and does not select", () => {
      const { onSelect } = renderCard({ isActive });
      const reference = screen.getByRole("button", { name: /pull request #101/ });
      expect(reference.getAttribute("aria-disabled")).toBeNull();

      fireEvent.click(reference);
      expect(dispatch).toHaveBeenCalledWith(
        "worktree.openPR",
        { worktreeId: WORKTREE.id },
        { source: "user" }
      );
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("the title never opens anything, even when it is the issue's title", () => {
      renderCard({ isActive });
      const title = screen.getByTestId("worktree-headline-title");
      expect(title.closest("button, a")).toBeNull();
      fireEvent.click(title);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("the More actions menu opens and its items act without selecting", async () => {
      const { onSelect } = renderCard({ isActive });
      fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
      // The item sits a submenu deep, so both layers are portalled from the card.
      press(await screen.findByRole("menuitem", { name: "Review" }));
      // A direct row at the menu's root, and the only one of that name: the
      // Review submenu no longer repeats it.
      press(await screen.findByRole("menuitem", { name: /Review worktree/ }));
      expect(dispatch).toHaveBeenCalledWith("worktree.openReviewHub", { worktreeId: WORKTREE.id });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("toolbar controls act without selecting", () => {
      const { onSelect } = renderCard({ isActive });
      press(screen.getByRole("button", { name: "Collapse card" }));
      expect(useWorktreeFilterStore.getState().collapsedWorktrees).toContain(WORKTREE.id);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("Review & commit opens the review without selecting", () => {
      const { onSelect } = renderCard({ isActive });
      fireEvent.click(screen.getByRole("button", { name: "Open Review & commit" }));
      expect(dispatch).toHaveBeenCalledWith("worktree.openReviewHub", { worktreeId: WORKTREE.id });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("a session row keeps its own click and does not select", () => {
      useWorktreeSelectionStore.setState({ expandedTerminals: new Set([WORKTREE.id]) });
      const { onSelect } = renderCard({ isActive });
      const armedBefore = useFleetArmingStore.getState().armedIds.has(SESSION.id);
      fireEvent.click(screen.getByRole("button", { name: SESSION.title }));
      // Whatever the row does (arming, here), it does it in place of selecting.
      expect(useFleetArmingStore.getState().armedIds.has(SESSION.id)).toBe(!armedBefore);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("a click arriving from a portalled layer never selects or folds the card", () => {
      // One item with a menu role and one that is plain content, so it is DOM
      // containment being tested here rather than the control list.
      renderDialogLayer = () =>
        createPortal(
          <div role="menu">
            <div role="menuitem">Copy path</div>
            <span>Plain text in a popover</span>
          </div>,
          document.body
        );
      const { onSelect } = renderCard({ isActive });
      expect(card().contains(screen.getByRole("menuitem"))).toBe(false);

      fireEvent.click(screen.getByRole("menuitem"));
      fireEvent.click(screen.getByText("Plain text in a popover"));
      fireEvent.doubleClick(screen.getByText("Plain text in a popover"));
      expect(onSelect).not.toHaveBeenCalled();
      expect(useWorktreeFilterStore.getState().collapsedWorktrees).not.toContain(WORKTREE.id);
    });

    it("the end of a drag-to-select in the card's text does not select", () => {
      const { onSelect } = renderCard({ isActive });
      const summary = screen.getByText("3 files");
      selectTextOf(summary);
      press(summary);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("the keyboard select button selects even while text in the card is selected", () => {
      const { onSelect } = renderCard({ isActive });
      selectTextOf(screen.getByText("3 files"));
      const select = screen.getByRole("button", { name: /^Select worktree:/ });
      // Enter/Space activate a button as a click with detail 0, which ends no drag.
      fireEvent.click(select, { detail: 0 });
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("a click on content while this card is being dragged to reorder does not select", () => {
      const { onSelect } = renderCard({ isActive, isDraggingSort: true });
      press(screen.getByText("3 files"));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("a double-click on content still folds the card, and on a control does not", () => {
      renderCard({ isActive });
      fireEvent.doubleClick(detailsButton());
      expect(useWorktreeFilterStore.getState().collapsedWorktrees).not.toContain(WORKTREE.id);
      // A double-click selects a word on its own; that must not stop the fold.
      selectTextOf(screen.getByText("3 files"));
      fireEvent.doubleClick(screen.getByText("3 files"));
      expect(useWorktreeFilterStore.getState().collapsedWorktrees).toContain(WORKTREE.id);
    });
  });
});
