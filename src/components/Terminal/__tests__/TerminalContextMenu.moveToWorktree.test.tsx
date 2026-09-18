// @vitest-environment jsdom
/**
 * The "Move to worktree" submenu (#12445) lists worktrees the way the sidebar
 * does: same order, same names. The ordering hook, the sidebar sort and the
 * headline helper all run for real here; only their inputs — the worktree list
 * and the four ordering preferences — are stubbed, so a regression back to the
 * raw `useWorktrees` order or an ad hoc label shows up as a wrong row.
 *
 * Past ten rows the submenu hands off to the searchable picker (#12446). The
 * picker itself is stubbed down to its props; the handoff through the real
 * overlays lives in `TerminalContextMenu.moveToWorktree.overlays.test.tsx`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, renderHook, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type React from "react";
import type { WorktreeState } from "@/types";
import type { OrderBy } from "@/store/worktreeFilterStore";

const {
  dispatch,
  worktreesRef,
  prefsRef,
  panelsById,
  menuOpenChange,
  menuCloseAutoFocus,
  pickerProps,
  anchorRef,
} = vi.hoisted(() => ({
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
  // The root's open hook and the root content's close hook, as the menu last
  // rendered them. Radix fires the close hook only from the root content,
  // whichever level the selected item sat at.
  menuOpenChange: { current: null as ((open: boolean) => void) | null },
  menuCloseAutoFocus: { current: null as ((event: Event) => void) | null },
  pickerProps: {
    current: null as {
      panelId: string;
      currentWorktreeId: string | undefined;
      isOpen: boolean;
      returnFocusRef: { current: HTMLElement | null };
      align?: string;
    } | null,
  },
  anchorRef: {
    current: null as {
      current: { contextElement: HTMLElement; getBoundingClientRect: () => DOMRect } | null;
    } | null,
  },
}));

// Render menu content synchronously — Radix only mounts it behind a real
// right-click into a portal. `disabled` and `aria-haspopup` are forwarded so
// they are readable off the button.
vi.mock("@/components/ui/context-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Item = ({
    children,
    onSelect,
    disabled,
    "aria-haspopup": ariaHasPopup,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    "aria-haspopup"?: React.AriaAttributes["aria-haspopup"];
  }) => (
    <button disabled={disabled} aria-haspopup={ariaHasPopup} onClick={() => onSelect?.()}>
      {children}
    </button>
  );
  const SubContent = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="sub-content">{children}</div>
  );
  return {
    ContextMenu: ({
      children,
      onOpenChange,
    }: {
      children?: React.ReactNode;
      onOpenChange?: (open: boolean) => void;
    }) => {
      menuOpenChange.current = onOpenChange ?? null;
      return <div>{children}</div>;
    },
    ContextMenuTrigger: Passthrough,
    ContextMenuContent: ({
      children,
      onCloseAutoFocus,
    }: {
      children?: React.ReactNode;
      onCloseAutoFocus?: (event: Event) => void;
    }) => {
      menuCloseAutoFocus.current = onCloseAutoFocus ?? null;
      return <div>{children}</div>;
    },
    ContextMenuItem: Item,
    ContextMenuActionItem: Item,
    ContextMenuCheckboxItem: Item,
    ContextMenuRadioGroup: Passthrough,
    ContextMenuRadioItem: Item,
    ContextMenuSeparator: () => <hr />,
    ContextMenuLabel: Passthrough,
    ContextMenuShortcut: Passthrough,
    ContextMenuGroup: Passthrough,
    ContextMenuPortal: Passthrough,
    ContextMenuSub: Passthrough,
    ContextMenuSubContent: SubContent,
    ContextMenuSubTrigger: Passthrough,
  };
});

vi.mock("@/components/Panel/MoveToWorktreePicker", () => ({
  MoveToWorktreePicker: (props: NonNullable<(typeof pickerProps)["current"]>) => {
    pickerProps.current = props;
    return props.isOpen ? (
      <div
        data-testid="move-picker"
        data-panel-id={props.panelId}
        data-current-worktree={props.currentWorktreeId}
      />
    ) : null;
  },
}));

vi.mock("@/components/ui/AppPalettePopover", () => ({
  AppPalettePopover: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/popover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/popover")>()),
  PopoverAnchor: ({ virtualRef }: { virtualRef?: NonNullable<(typeof anchorRef)["current"]> }) => {
    anchorRef.current = virtualRef ?? null;
    return null;
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, get: () => undefined, list: () => [] },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: () => undefined,
    getTerminal: () => undefined,
    getSelection: () => "",
  },
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

vi.mock("@/store", () => {
  const state = () => ({
    panelsById: panelsById.current,
    maximizeTarget: null,
    getPanelGroup: () => undefined,
    watchedPanels: new Set<string>(),
  });
  const usePanelStore = (selector: (s: unknown) => unknown) => selector(state());
  usePanelStore.getState = state;
  return { usePanelStore };
});

import { TerminalContextMenu } from "../TerminalContextMenu";
import { getWorktreeHeadline } from "@/lib/worktreeHeadline";
import { useSidebarWorktreeOrder } from "@/hooks/useSidebarWorktreeOrder";

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

const MORE = "More worktrees…";

// Main plus `count - 1` others, fed newest-last with one old worktree pinned,
// so the sidebar's order differs from both the input and a plain age sort.
function manyWorktrees(count: number): WorktreeState[] {
  const others = Array.from({ length: count - 1 }, (_, i) =>
    createWorktree({
      id: `wt-${i}`,
      path: `/wt/${i}`,
      name: `wt-${i}`,
      branch: `feature/wt-${i}`,
      createdAt: T + i,
    })
  );
  prefsRef.current = { ...prefsRef.current, pinnedWorktrees: ["wt-0"] };
  return [...others, main];
}

function subContent(): HTMLElement {
  const trigger = screen.getByText("Move to worktree");
  return trigger.parentElement!.querySelector<HTMLElement>('[data-testid="sub-content"]')!;
}

function rightClickPane(init: MouseEventInit = { clientX: 0, clientY: 0 }) {
  fireEvent.contextMenu(screen.getByText("Panel body"), init);
}

/** Radix's close for the root content, which a submenu selection also ends in. */
function closeMenu(): Event {
  const event = new Event("focusout", { cancelable: true });
  act(() => menuCloseAutoFocus.current?.(event));
  return event;
}

function renderPanel(terminalId: string) {
  return (
    <TerminalContextMenu terminalId={terminalId}>
      <div>Panel body</div>
    </TerminalContextMenu>
  );
}

// One panel of each kind that picks a different return branch of the menu.
const MENU_BRANCHES: Array<[string, Record<string, unknown>]> = [
  ["browser", { kind: "browser", browserUrl: "https://example.com" }],
  ["dev-preview", { kind: "dev-preview", browserUrl: "http://localhost:3000" }],
  ["review", { kind: "review" }],
  ["file", { kind: "file", filePath: "/repo/README.md" }],
  ["terminal", { kind: "terminal", cwd: "/repo" }],
];

describe("TerminalContextMenu — Move to worktree cap and picker handoff (#12446)", () => {
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
    menuOpenChange.current = null;
    menuCloseAutoFocus.current = null;
    pickerProps.current = null;
    anchorRef.current = null;
  });

  it.each([11, 12])(
    "shows the first ten sidebar rows of %i, a separator and More worktrees…",
    (count) => {
      const worktrees = manyWorktrees(count);
      openMenu(worktrees);

      const sidebarOrder = renderHook(() => useSidebarWorktreeOrder()).result.current;
      const rows = moveRows();
      expect(rows).toHaveLength(11);
      expect(labels(rows.slice(0, 10))).toEqual(
        sidebarOrder.slice(0, 10).map((wt) => getWorktreeHeadline(wt).label)
      );
      // Neither the input order nor a plain age sort: the pin moved wt-0 up.
      expect(labels(rows.slice(0, 10))).not.toEqual(
        worktrees.slice(0, 10).map((wt) => getWorktreeHeadline(wt).label)
      );
      expect(labels(rows)[1]).toBe("feature/wt-0");

      const separators = subContent().querySelectorAll("hr");
      expect(separators).toHaveLength(1);
      expect(separators[0]!.nextElementSibling).toBe(rows[10]);
      expect(rows[10]!.textContent).toBe(MORE);
      expect(rows[10]!.getAttribute("aria-haspopup")).toBe("dialog");
    }
  );

  it("keeps the icon on every row, More worktrees… included", () => {
    openMenu(manyWorktrees(12));

    for (const row of moveRows()) {
      expect(row.querySelector("svg")).not.toBeNull();
    }
  });

  it.each([5, 10])("lists all %i worktrees with no separator or More row", (count) => {
    openMenu(manyWorktrees(count));

    expect(moveRows()).toHaveLength(count);
    expect(subContent().querySelector("hr")).toBeNull();
    expect(screen.queryByText(MORE)).toBeNull();
  });

  it("opens the picker for this terminal once the menu has closed, and dispatches nothing", () => {
    openMenu(manyWorktrees(12), "wt-3");
    rightClickPane();

    fireEvent.click(screen.getByText(MORE));
    // Not from the select itself: the menu still holds its focus trap there.
    expect(screen.queryByTestId("move-picker")).toBeNull();

    const event = closeMenu();

    const picker = screen.getByTestId("move-picker");
    expect(picker.getAttribute("data-panel-id")).toBe("panel-1");
    expect(picker.getAttribute("data-current-worktree")).toBe("wt-3");
    expect(event.defaultPrevented).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still dispatches a row's move and leaves the picker closed", () => {
    openMenu(manyWorktrees(12));
    rightClickPane();

    fireEvent.click(screen.getByText("feature/wt-0"));
    const event = closeMenu();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "terminal.moveToWorktree",
      { terminalId: "panel-1", worktreeId: "wt-0" },
      { source: "user" }
    );
    expect(screen.queryByTestId("move-picker")).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it("anchors on the point the menu opened at, tracked against the pane", () => {
    openMenu(manyWorktrees(12));
    const pane = screen.getByText("Panel body");
    const rect = vi
      .spyOn(pane, "getBoundingClientRect")
      .mockReturnValue(DOMRect.fromRect({ x: 100, y: 50, width: 400, height: 300 }));

    rightClickPane({ clientX: 160, clientY: 90 });
    fireEvent.click(screen.getByText(MORE));
    closeMenu();

    const anchor = anchorRef.current?.current;
    expect(anchor?.contextElement).toBe(pane);
    expect(pickerProps.current?.returnFocusRef.current).toBe(pane);
    const point = anchor!.getBoundingClientRect();
    expect([point.x, point.y, point.width, point.height]).toEqual([160, 90, 0, 0]);

    // The pane moved: the point moves with it.
    rect.mockReturnValue(DOMRect.fromRect({ x: 200, y: 80, width: 400, height: 300 }));
    const moved = anchor!.getBoundingClientRect();
    expect([moved.x, moved.y]).toEqual([260, 120]);
  });

  // Radix opens on a touch or pen long-press straight from its own timer, with
  // no contextmenu event behind it.
  it("anchors on the press point when a long-press opened the menu", () => {
    openMenu(manyWorktrees(12));
    const pane = screen.getByText("Panel body");
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 100, y: 50, width: 400, height: 300 })
    );

    fireEvent.pointerDown(pane, { pointerType: "touch", clientX: 220, clientY: 140 });
    fireEvent.click(screen.getByText(MORE));
    closeMenu();

    expect(screen.getByTestId("move-picker").getAttribute("data-panel-id")).toBe("panel-1");
    expect(pickerProps.current?.returnFocusRef.current).toBe(pane);
    const point = anchorRef.current!.current!.getBoundingClientRect();
    expect([point.x, point.y]).toEqual([220, 140]);
  });

  it("closes the picker when the menu starts speaking for another panel, and keeps it closed", () => {
    worktreesRef.current = manyWorktrees(12);
    panelsById.current = {
      "panel-1": { id: "panel-1", title: "One", kind: "terminal", worktreeId: "wt-main" },
      "panel-2": { id: "panel-2", title: "Two", kind: "terminal", worktreeId: "wt-main" },
    };
    const { rerender } = render(renderPanel("panel-1"));
    rightClickPane();
    fireEvent.click(screen.getByText(MORE));
    closeMenu();
    expect(screen.getByTestId("move-picker").getAttribute("data-panel-id")).toBe("panel-1");

    rerender(renderPanel("panel-2"));
    expect(screen.queryByTestId("move-picker")).toBeNull();

    rerender(renderPanel("panel-1"));
    expect(screen.queryByTestId("move-picker")).toBeNull();
  });

  it("ignores a request made for the panel the menu no longer speaks for", () => {
    worktreesRef.current = manyWorktrees(12);
    panelsById.current = {
      "panel-1": { id: "panel-1", title: "One", kind: "terminal", worktreeId: "wt-main" },
      "panel-2": { id: "panel-2", title: "Two", kind: "terminal", worktreeId: "wt-main" },
    };
    const { rerender } = render(renderPanel("panel-1"));
    rightClickPane();
    fireEvent.click(screen.getByText(MORE));

    rerender(renderPanel("panel-2"));
    closeMenu();

    expect(screen.queryByTestId("move-picker")).toBeNull();

    // The next request is made for, and opens for, the panel it now speaks for.
    rightClickPane();
    fireEvent.click(screen.getByText(MORE));
    closeMenu();

    expect(screen.getByTestId("move-picker").getAttribute("data-panel-id")).toBe("panel-2");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(MENU_BRANCHES)("hands off to the picker from the %s menu", (_label, fields) => {
    worktreesRef.current = manyWorktrees(12);
    panelsById.current = {
      "panel-1": { id: "panel-1", title: "Panel", worktreeId: "wt-main", ...fields },
    };
    render(renderPanel("panel-1"));
    rightClickPane();

    fireEvent.click(screen.getByText(MORE));
    closeMenu();

    expect(screen.getByTestId("move-picker").getAttribute("data-panel-id")).toBe("panel-1");
    expect(anchorRef.current?.current?.contextElement).toBe(screen.getByText("Panel body"));
  });

  it.each(MENU_BRANCHES)(
    "drops a request when the %s menu reopens before its close hook",
    (_label, fields) => {
      worktreesRef.current = manyWorktrees(12);
      panelsById.current = {
        "panel-1": { id: "panel-1", title: "Panel", worktreeId: "wt-main", ...fields },
      };
      render(renderPanel("panel-1"));
      rightClickPane();

      fireEvent.click(screen.getByText(MORE));
      expect(menuOpenChange.current).toEqual(expect.any(Function));
      act(() => menuOpenChange.current!(true));
      const event = closeMenu();

      expect(screen.queryByTestId("move-picker")).toBeNull();
      expect(event.defaultPrevented).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    }
  );
});
