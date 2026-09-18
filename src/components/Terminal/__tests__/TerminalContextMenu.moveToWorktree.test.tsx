// @vitest-environment jsdom
/**
 * The "Move to worktree" submenu (#12445) lists worktrees the way the sidebar
 * does: same order, same names. The ordering hook, the sidebar sort and the
 * headline helper all run for real here; only their inputs — the worktree list
 * and the four ordering preferences — are stubbed, so a regression back to the
 * raw `useWorktrees` order or an ad hoc label shows up as a wrong row.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type React from "react";
import type { WorktreeState } from "@/types";
import type { OrderBy } from "@/store/worktreeFilterStore";

// Render menu content synchronously — Radix only mounts it behind a real
// right-click into a portal. `disabled` is forwarded so the current row's state
// is readable off the button.
vi.mock("@/components/ui/context-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Item = ({
    children,
    onSelect,
    disabled,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  );
  const SubContent = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="sub-content">{children}</div>
  );
  return {
    ContextMenu: Passthrough,
    ContextMenuTrigger: Passthrough,
    ContextMenuContent: Passthrough,
    ContextMenuItem: Item,
    ContextMenuActionItem: Item,
    ContextMenuCheckboxItem: Item,
    ContextMenuRadioGroup: Passthrough,
    ContextMenuRadioItem: Item,
    ContextMenuSeparator: () => null,
    ContextMenuLabel: Passthrough,
    ContextMenuShortcut: Passthrough,
    ContextMenuGroup: Passthrough,
    ContextMenuPortal: Passthrough,
    ContextMenuSub: Passthrough,
    ContextMenuSubContent: SubContent,
    ContextMenuSubTrigger: Passthrough,
  };
});

const { dispatch, worktreesRef, prefsRef, panelsById } = vi.hoisted(() => ({
  dispatch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  worktreesRef: { current: [] as unknown[] },
  prefsRef: {
    current: {
      orderBy: "created" as OrderBy,
      groupByType: false,
      pinnedWorktrees: [] as string[],
      manualOrder: [] as string[],
    },
  },
  panelsById: { current: {} as Record<string, unknown> },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, get: () => undefined, list: () => [] },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { getTerminal: () => undefined, getSelection: () => "" },
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({ worktrees: worktreesRef.current }),
}));

vi.mock("@/store/worktreeFilterStore", () => ({
  useWorktreeFilterStore: (selector: (state: unknown) => unknown) => selector(prefsRef.current),
}));

vi.mock("@/hooks/useIsHibernated", () => ({ useIsHibernated: () => false }));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));

vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) =>
    selector({ lockedTarget: null, recentTargets: [] }),
}));

vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: (selector: (s: { armedIds: Set<string> }) => unknown) =>
    selector({ armedIds: new Set<string>() }),
  isFleetArmEligible: () => false,
}));

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: unknown) => unknown) =>
    selector({
      panelsById: panelsById.current,
      maximizeTarget: null,
      getPanelGroup: () => undefined,
      watchedPanels: new Set<string>(),
    }),
}));

import { TerminalContextMenu } from "../TerminalContextMenu";
import { getWorktreeHeadline } from "@/lib/worktreeHeadline";

const T = 1_700_000_000_000;

const createWorktree = (overrides: Partial<WorktreeState>): WorktreeState =>
  ({
    id: "id",
    worktreeId: "id",
    path: "/repo",
    name: "name",
    branch: "feature/x",
    isCurrent: false,
    isMainWorktree: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    ...overrides,
  }) as WorktreeState;

const main = createWorktree({
  id: "wt-main",
  path: "/repo",
  name: "daintree",
  branch: "main",
  isMainWorktree: true,
});
const issue = createWorktree({
  id: "wt-issue",
  path: "/wt/issue",
  name: "issue-12431",
  branch: "feature/issue-12431-add-systemprompt",
  issueNumber: 12431,
  issueTitle: "Add systemPrompt to agent launches",
  createdAt: T + 400,
});
const pr = createWorktree({
  id: "wt-pr",
  path: "/wt/pr",
  name: "pr-8888",
  branch: "fix/panel-focus",
  sourcePrNumber: 8888,
  prTitle: "Keep focus on the panel after closing a dialog",
  createdAt: T + 300,
});
const plain = createWorktree({
  id: "wt-plain",
  path: "/wt/plain",
  name: "tidy",
  branch: "chore/tidy-imports",
  createdAt: T + 200,
});
const blank = createWorktree({
  id: "wt-blank",
  path: "/wt/blank",
  name: "blank",
  branch: "",
  createdAt: T + 100,
});

function openMenu(worktrees: WorktreeState[], currentWorktreeId = "wt-main") {
  worktreesRef.current = worktrees;
  panelsById.current = {
    "panel-1": {
      id: "panel-1",
      title: "Agent",
      kind: "terminal",
      worktreeId: currentWorktreeId,
      cwd: "/repo",
    },
  };
  return render(
    <TerminalContextMenu terminalId="panel-1">
      <div>Panel body</div>
    </TerminalContextMenu>
  );
}

function moveRows(): HTMLButtonElement[] {
  const trigger = screen.getByText("Move to worktree");
  const sub = trigger.parentElement!.querySelector('[data-testid="sub-content"]')!;
  return Array.from(sub.querySelectorAll("button"));
}

const labels = (rows: HTMLButtonElement[]) => rows.map((row) => row.textContent);

describe("TerminalContextMenu — Move to worktree (#12445)", () => {
  beforeEach(() => {
    prefsRef.current = {
      orderBy: "created",
      groupByType: false,
      pinnedWorktrees: [],
      manualOrder: [],
    };
  });

  afterEach(() => {
    cleanup();
    dispatch.mockReset();
    worktreesRef.current = [];
    panelsById.current = {};
  });

  // Fed in an order the sidebar never produces, so a row order that simply
  // mirrored the input would fail here.
  it("lists main first, then a pinned worktree ahead of a newer unpinned one", () => {
    const pinnedOlder = createWorktree({
      id: "wt-pinned",
      path: "/wt/pinned",
      name: "pinned",
      branch: "feature/pinned",
      createdAt: T + 100,
    });
    const unpinnedNewer = createWorktree({
      id: "wt-newer",
      path: "/wt/newer",
      name: "newer",
      branch: "feature/newer",
      createdAt: T + 900,
    });
    prefsRef.current = { ...prefsRef.current, pinnedWorktrees: ["wt-pinned"] };

    openMenu([unpinnedNewer, pinnedOlder, main]);

    expect(labels(moveRows())).toEqual(["daintree", "feature/pinned", "feature/newer"]);
  });

  it("labels each row with its sidebar headline", () => {
    const worktrees = [main, issue, pr, plain, blank];
    openMenu(worktrees);

    expect(labels(moveRows())).toEqual(worktrees.map((wt) => getWorktreeHeadline(wt).label));
    // Pins the fixtures to the four headline kinds, so the equality above is
    // not comparing four branch names with each other.
    expect(worktrees.map((wt) => getWorktreeHeadline(wt).kind)).toEqual([
      "main",
      "issue",
      "pr",
      "branch",
      "branch",
    ]);
    expect(labels(moveRows())).toContain("Untitled worktree");
  });

  it("disables the current worktree in its natural position", () => {
    openMenu([main, issue, pr, plain], "wt-pr");

    const rows = moveRows();
    expect(labels(rows)).toEqual(
      [main, issue, pr, plain].map((wt) => getWorktreeHeadline(wt).label)
    );
    expect(rows.map((row) => row.disabled)).toEqual([false, false, true, false]);
  });

  it("dispatches terminal.moveToWorktree for the selected row", () => {
    openMenu([main, issue, pr, plain], "wt-main");

    fireEvent.click(screen.getByText(getWorktreeHeadline(issue).label));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "terminal.moveToWorktree",
      { terminalId: "panel-1", worktreeId: "wt-issue" },
      { source: "user" }
    );
  });

  it("omits the submenu when there is nowhere else to move", () => {
    openMenu([main]);

    expect(screen.queryByText("Move to worktree")).toBeNull();
  });
});
