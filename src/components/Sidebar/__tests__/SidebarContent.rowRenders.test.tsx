// @vitest-environment jsdom
/**
 * A cursor, focus or selection step in the sidebar changes the Virtuoso
 * context every row is drawn from. Only the rows whose own state moved may
 * re-render their card; the rest must stop at the row's memo (#17072).
 */
import type React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";
import type { SidebarFlatItem } from "../sidebarWorktreeModel";

const cardRenders = vi.hoisted(() => new Map<string, number>());

vi.mock("@/components/Worktree", () => ({
  WorktreeCard: ({
    worktree,
    isActive,
    isFocused,
    isKeyboardCursor,
    isSingleWorktree,
  }: {
    worktree: WorktreeState;
    isActive: boolean;
    isFocused: boolean;
    isKeyboardCursor: boolean;
    isSingleWorktree: boolean;
  }) => {
    cardRenders.set(worktree.id, (cardRenders.get(worktree.id) ?? 0) + 1);
    return (
      <div
        data-testid={`card-${worktree.id}`}
        data-active={String(isActive)}
        data-focused={String(isFocused)}
        data-cursor={String(isKeyboardCursor)}
        data-single={String(isSingleWorktree)}
      />
    );
  },
}));

vi.mock("@/components/DragDrop/SortableWorktreeCard", () => ({
  SortableWorktreeCard: ({
    children,
  }: {
    children: (state: {
      isDraggingSort: boolean;
      dragHandleListeners: undefined;
      dragHandleActivatorRef: () => void;
    }) => React.ReactNode;
  }) =>
    children({
      isDraggingSort: false,
      dragHandleListeners: undefined,
      dragHandleActivatorRef: () => {},
    }),
}));

import { renderSidebarFlatItem, type SidebarVirtuosoContext } from "../SidebarContent";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";

const IDS = ["wt-a", "wt-b", "wt-c", "wt-d"];

function worktree(id: string): WorktreeState {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    branch: id,
    isCurrent: false,
    isMainWorktree: false,
  } as WorktreeState;
}

const selectWorktree = vi.fn();
const worktreeActions = {} as SidebarVirtuosoContext["worktreeActions"];
const availability = {} as SidebarVirtuosoContext["availability"];
const DRAG_ORDER = [...IDS];

function context(overrides: Partial<SidebarVirtuosoContext> = {}): SidebarVirtuosoContext {
  return {
    activeWorktreeId: null,
    focusedWorktreeId: null,
    keyboardCursorId: null,
    totalWorktreeCount: IDS.length,
    selectWorktree,
    worktreeActions,
    availability,
    agentSettings: undefined as unknown as SidebarVirtuosoContext["agentSettings"],
    homeDir: undefined,
    dragStartOrder: DRAG_ORDER,
    isSortDisabled: false,
    dragDisabledReason: null,
    ...overrides,
  };
}

function items(mode: "sortable" | "static"): SidebarFlatItem[] {
  return IDS.map((id, rowIndex) => ({
    kind: "row",
    id,
    worktreeId: id,
    ariaRowIndex: rowIndex + 2,
    rowIndex,
    isPinned: false,
    mode,
  }));
}

function Rows({ list, ctx }: { list: SidebarFlatItem[]; ctx: SidebarVirtuosoContext }) {
  return (
    <>
      {list.map((item, index) => (
        <div key={item.id}>{renderSidebarFlatItem(index, item, ctx)}</div>
      ))}
    </>
  );
}

function setup(mode: "sortable" | "static") {
  const store = createWorktreeStore();
  store.setState({ worktrees: new Map(IDS.map((id) => [id, worktree(id)])) });
  const list = items(mode);
  const view = render(
    <WorktreeStoreContext.Provider value={store}>
      <Rows list={list} ctx={context()} />
    </WorktreeStoreContext.Provider>
  );
  const step = (overrides: Partial<SidebarVirtuosoContext>) => {
    cardRenders.clear();
    view.rerender(
      <WorktreeStoreContext.Provider value={store}>
        <Rows list={list} ctx={context(overrides)} />
      </WorktreeStoreContext.Provider>
    );
  };
  return { view, step };
}

beforeEach(() => {
  cardRenders.clear();
});

afterEach(() => {
  cleanup();
});

describe.each(["sortable", "static"] as const)("sidebar %s rows (#17072)", (mode) => {
  it("re-renders only the two cards a keyboard cursor step moves between", () => {
    const { view, step } = setup(mode);
    step({ keyboardCursorId: "wt-a" });
    expect([...cardRenders.keys()]).toEqual(["wt-a"]);

    step({ keyboardCursorId: "wt-b" });
    expect([...cardRenders.keys()].sort()).toEqual(["wt-a", "wt-b"]);
    expect(view.getByTestId("card-wt-a").dataset.cursor).toBe("false");
    expect(view.getByTestId("card-wt-b").dataset.cursor).toBe("true");
  });

  it("re-renders only the cards whose focus or selection changed", () => {
    const { view, step } = setup(mode);
    step({ focusedWorktreeId: "wt-c" });
    expect([...cardRenders.keys()]).toEqual(["wt-c"]);
    expect(view.getByTestId("card-wt-c").dataset.focused).toBe("true");

    step({ focusedWorktreeId: "wt-c", activeWorktreeId: "wt-d" });
    expect([...cardRenders.keys()]).toEqual(["wt-d"]);
    expect(view.getByTestId("card-wt-d").dataset.active).toBe("true");
  });

  it("re-renders no card when the step lands on a row outside the list", () => {
    const { step } = setup(mode);
    step({ keyboardCursorId: "not-in-list" });
    expect(cardRenders.size).toBe(0);
  });

  it("re-renders every card when the worktree count crosses one", () => {
    const { view, step } = setup(mode);
    expect(view.getByTestId("card-wt-a").dataset.single).toBe("false");
    step({ totalWorktreeCount: 1 });
    expect(cardRenders.size).toBe(IDS.length);
    for (const id of IDS) expect(view.getByTestId(`card-${id}`).dataset.single).toBe("true");
  });
});
