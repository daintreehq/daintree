import { describe, it, expect, beforeEach } from "vitest";
import { MAX_CONSOLE_ROWS } from "@shared/config/devPreviewConsole";
import {
  useConsoleCaptureStore,
  flushConsoleCaptureBuffer,
  type ConsoleMessage,
} from "@/store/consoleCaptureStore";
import type { CdpConsoleType, SerializedConsoleRow } from "@shared/types/ipc/webviewConsole";
import { pruneToLiveRows, reconcileCollapsedGroups, scanArrivedRows } from "../consoleRowState";

const PANE = "pane-1";

const row = (id: number, cdpType = "log") => ({ id, cdpType });

describe("scanArrivedRows", () => {
  it("collects every collapsed group on the first scan", () => {
    const rows = [row(1, "startGroupCollapsed"), row(2), row(3, "startGroupCollapsed")];
    expect(scanArrivedRows(rows, null)).toEqual({ tailId: 3, collapsedIds: [1, 3] });
  });

  it("reports nothing new when the tail is unchanged", () => {
    const rows = [row(1, "startGroupCollapsed"), row(2)];
    expect(scanArrivedRows(rows, 2)).toEqual({ tailId: 2, collapsedIds: null });
  });

  it("scans only rows past the last-seen tail across eviction", () => {
    // Same length as before, with the head evicted and new ids at the end.
    const rows = [row(3, "startGroupCollapsed"), row(4), row(5, "startGroupCollapsed")];
    expect(scanArrivedRows(rows, 3)).toEqual({ tailId: 5, collapsedIds: [5] });
  });

  it("treats every row as new when the batch evicted the previous tail", () => {
    const rows = [row(10, "startGroupCollapsed"), row(11, "startGroupCollapsed")];
    expect(scanArrivedRows(rows, 4)).toEqual({ tailId: 11, collapsedIds: [10, 11] });
  });

  it("returns an empty cursor for an empty buffer", () => {
    expect(scanArrivedRows([], 7)).toEqual({ tailId: null, collapsedIds: null });
  });
});

describe("reconcileCollapsedGroups", () => {
  it("returns the same set when nothing was evicted or added", () => {
    const prev = new Set([1, 3]);
    const rows = [row(1), row(2), row(3)];
    expect(reconcileCollapsedGroups(prev, rows, null)).toBe(prev);
    expect(reconcileCollapsedGroups(prev, rows, [3])).toBe(prev);
  });

  it("drops evicted ids and adds arrived ones in one copy", () => {
    const prev = new Set([1, 3]);
    const next = reconcileCollapsedGroups(prev, [row(3), row(4), row(5)], [5]);
    expect([...next].sort()).toEqual([3, 5]);
    expect(prev).toEqual(new Set([1, 3]));
  });

  it("drops evicted ids when only ordinary logs arrived", () => {
    const next = reconcileCollapsedGroups(new Set([1, 2]), [row(2), row(3)], null);
    expect(next).toEqual(new Set([2]));
  });

  it("skips the live scan when there is nothing to prune", () => {
    const prev = new Set<number>();
    expect(reconcileCollapsedGroups(prev, [row(1)], null)).toBe(prev);
    expect(reconcileCollapsedGroups(prev, [row(1)], [1])).toEqual(new Set([1]));
  });
});

describe("pruneToLiveRows", () => {
  it("returns the same map when every key is live", () => {
    const prev = new Map([[2, "a"]]);
    expect(pruneToLiveRows(prev, [row(1), row(2)])).toBe(prev);
  });

  it("keeps surviving values by reference", () => {
    const view = { expanded: true };
    const next = pruneToLiveRows(
      new Map([
        [1, { expanded: false }],
        [2, view],
      ]),
      [row(2), row(3)]
    );
    expect([...next.keys()]).toEqual([2]);
    expect(next.get(2)).toBe(view);
  });
});

describe("streaming past the buffer cap", () => {
  let nextId = 0;

  function enqueue(cdpType: CdpConsoleType, groupDepth = 0): number {
    const id = nextId++;
    const message: SerializedConsoleRow = {
      id,
      paneId: PANE,
      level: "log",
      cdpType,
      args: [],
      summaryText: `row ${id}`,
      timestamp: 0,
      navigationGeneration: 0,
      groupDepth,
    };
    useConsoleCaptureStore.getState().addStructuredMessage(message);
    return id;
  }

  function liveRows(): ConsoleMessage[] {
    return useConsoleCaptureStore.getState().getMessages(PANE);
  }

  beforeEach(() => {
    nextId = 0;
    useConsoleCaptureStore.setState({ messages: new Map(), counters: new Map() });
  });

  it("never holds more state than live rows while user choices survive until eviction", () => {
    let collapsed = new Set<number>();
    let stacks = new Map<number, { expanded: boolean }>();
    let tailId: number | null = null;

    // The same steps ConsolePanel runs whenever the buffer changes.
    const settle = () => {
      flushConsoleCaptureBuffer();
      const rows = liveRows();
      const arrived = scanArrivedRows(rows, tailId);
      tailId = arrived.tailId;
      collapsed = reconcileCollapsedGroups(collapsed, rows, arrived.collapsedIds);
      stacks = pruneToLiveRows(stacks, rows);

      const live = new Set(rows.map((msg) => msg.id));
      expect(collapsed.size).toBeLessThanOrEqual(rows.length);
      expect(stacks.size).toBeLessThanOrEqual(rows.length);
      for (const id of collapsed) expect(live.has(id)).toBe(true);
      for (const id of stacks.keys()) expect(live.has(id)).toBe(true);
      return live;
    };

    // A user expands one default-collapsed group, collapses one ordinary
    // group, and opens one stack.
    const expandedByUser = enqueue("startGroupCollapsed");
    enqueue("log", 1);
    const collapsedByUser = enqueue("startGroup");
    enqueue("log", 1);
    const stackOpened = enqueue("error");
    settle();
    collapsed = new Set(collapsed);
    collapsed.delete(expandedByUser);
    collapsed.add(collapsedByUser);
    stacks = new Map(stacks).set(stackOpened, { expanded: true });

    // A redux-logger style stream: one collapsed group with a child per
    // frame, thousands of them, until the user's rows age out.
    let groupsStreamed = 0;
    let userRowsLive = true;
    while (groupsStreamed < 5_000) {
      enqueue("startGroupCollapsed");
      enqueue("log", 1);
      groupsStreamed++;
      const live = settle();

      const tail = liveRows().at(-2)!;
      expect(collapsed.has(tail.id)).toBe(true);

      // An expanded group is never re-collapsed by later arrivals.
      expect(collapsed.has(expandedByUser)).toBe(false);
      expect(collapsed.has(collapsedByUser)).toBe(live.has(collapsedByUser));
      expect(stacks.has(stackOpened)).toBe(live.has(stackOpened));
      if (!live.has(stackOpened)) userRowsLive = false;
    }

    expect(userRowsLive).toBe(false);
    expect(liveRows()).toHaveLength(MAX_CONSOLE_ROWS);
    expect(collapsed.has(collapsedByUser)).toBe(false);
    expect(stacks.size).toBe(0);
    // Half of the live rows are collapsed headers; the rest are their children.
    expect(collapsed.size).toBe(MAX_CONSOLE_ROWS / 2);
  });

  it("prunes on a batch large enough to evict the previous tail", () => {
    let collapsed = new Set<number>();
    for (let i = 0; i < 10; i++) enqueue("startGroupCollapsed");
    flushConsoleCaptureBuffer();
    let rows = liveRows();
    const first = scanArrivedRows(rows, null);
    collapsed = reconcileCollapsedGroups(collapsed, rows, first.collapsedIds);
    expect(collapsed.size).toBe(10);

    for (let i = 0; i < MAX_CONSOLE_ROWS + 50; i++) enqueue(i % 2 ? "log" : "startGroupCollapsed");
    flushConsoleCaptureBuffer();
    rows = liveRows();
    const second = scanArrivedRows(rows, first.tailId);
    collapsed = reconcileCollapsedGroups(collapsed, rows, second.collapsedIds);

    expect(second.collapsedIds).toHaveLength(MAX_CONSOLE_ROWS / 2);
    expect(collapsed.size).toBe(MAX_CONSOLE_ROWS / 2);
    const live = new Set(rows.map((msg) => msg.id));
    for (const id of collapsed) expect(live.has(id)).toBe(true);
  });
});
