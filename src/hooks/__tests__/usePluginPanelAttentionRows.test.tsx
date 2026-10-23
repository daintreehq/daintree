// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import { usePanelStore } from "@/store/panelStore";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import {
  _resetPluginPanelActivityStoreForTest,
  usePluginPanelActivityStore,
} from "@/store/pluginPanelActivityStore";
import {
  _resetPluginPanelAttentionStoreForTest,
  usePluginPanelAttentionStore,
} from "@/store/pluginPanelAttentionStore";
import {
  readPluginWorktreeAttention,
  usePluginAttentionUnreadRows,
  usePluginAttentionWaitingRows,
  usePluginPanelAttentionRows,
} from "../usePluginPanelAttentionRows";

function registerKind(id: string, extensionId: string, hasPty = false): void {
  registerPanelKind({
    id,
    name: id,
    iconId: "puzzle",
    color: "#abcdef",
    hasPty,
    canRestart: false,
    canConvert: false,
    extensionId,
    reportsActivity: true,
  });
}

type PanelsById = ReturnType<typeof usePanelStore.getState>["panelsById"];

function seedPanels(panels: Record<string, Record<string, unknown>>): void {
  usePanelStore.setState({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only id/title/kind/location/worktreeId are read
    panelsById: Object.fromEntries(
      Object.entries(panels).map(([id, panel]) => [id, { id, location: "grid", ...panel }])
    ) as PanelsById,
  });
}

function grant(...pluginIds: string[]): void {
  usePluginPanelAttentionStore.setState({ grantedPluginIds: new Set(pluginIds) });
}

beforeEach(() => {
  registerKind("acme.board", "acme");
  registerKind("acme.shell", "acme", true);
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([["acme", { devMode: false, displayName: "Acme Board" }]]),
  });
});

afterEach(() => {
  unregisterPanelKind("acme.board");
  unregisterPanelKind("acme.shell");
  _resetPluginPanelActivityStoreForTest();
  _resetPluginPanelAttentionStoreForTest();
  _resetPluginRuntimeStoreForTest();
  usePanelStore.setState({ panelsById: {} });
});

describe("usePluginPanelAttentionRows (#13821)", () => {
  it("is empty until the user switches the plugin on", () => {
    seedPanels({ p1: { title: "Board", kind: "acme.board", worktreeId: "wt-1" } });
    usePluginPanelActivityStore.setState({
      activityByPanelId: { p1: { acme: { state: "waiting", revision: 1 } } },
    });
    const { result } = renderHook(() => usePluginPanelAttentionRows());
    expect(result.current).toEqual([]);

    act(() => grant("acme"));
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      panelId: "p1",
      title: "Board",
      pluginName: "Acme Board",
      worktreeId: "wt-1",
      band: "needs-you",
    });
  });

  it("reads a PTY-backed plugin panel's reporter off its plugin kind", () => {
    grant("acme");
    seedPanels({ t1: { title: "Shell", kind: "terminal", pluginPanelKindId: "acme.shell" } });
    usePluginPanelActivityStore.setState({
      activityByPanelId: { t1: { acme: { state: "failed", revision: 2 } } },
    });
    const { result } = renderHook(() => usePluginPanelAttentionRows());
    expect(result.current[0]).toMatchObject({ panelId: "t1", band: "blocked", worktreeId: null });
  });

  it("splits rows between the Waiting and Unread pills and feeds the worktree buckets", () => {
    grant("acme");
    seedPanels({
      a: { title: "A", kind: "acme.board", worktreeId: "wt-1" },
      b: { title: "B", kind: "acme.board", worktreeId: "wt-2" },
    });
    usePluginPanelActivityStore.setState({
      activityByPanelId: {
        a: { acme: { state: "waiting", revision: 1 } },
        b: { acme: { state: "finished", revision: 2 } },
      },
    });
    const waiting = renderHook(() => usePluginAttentionWaitingRows()).result.current;
    const unread = renderHook(() => usePluginAttentionUnreadRows()).result.current;
    expect(waiting.map((row) => row.panelId)).toEqual(["a"]);
    expect(unread.map((row) => row.panelId)).toEqual(["b"]);

    const byWorktree = readPluginWorktreeAttention();
    expect(byWorktree.get("wt-1")?.attention).toBe(true);
    expect(byWorktree.get("wt-2")).toMatchObject({ finished: true, unseen: true });
  });

  it("keeps its result across a panel store write that touches no reported panel", () => {
    grant("acme");
    seedPanels({ p1: { title: "Board", kind: "acme.board" } });
    usePluginPanelActivityStore.setState({
      activityByPanelId: { p1: { acme: { state: "working", revision: 1 } } },
    });
    const { result } = renderHook(() => usePluginPanelAttentionRows());
    const first = result.current;

    act(() =>
      seedPanels({
        p1: { title: "Board", kind: "acme.board" },
        other: { title: "x", kind: "terminal" },
      })
    );
    expect(result.current).toBe(first);
  });

  it("follows a kind that registers after its panel and report arrived", () => {
    grant("late");
    seedPanels({ p1: { title: "Late", kind: "late.board" } });
    usePluginPanelActivityStore.setState({
      activityByPanelId: { p1: { late: { state: "waiting", revision: 1 } } },
    });
    const { result } = renderHook(() => usePluginPanelAttentionRows());
    expect(result.current).toEqual([]);

    act(() => registerKind("late.board", "late"));
    try {
      expect(result.current.map((row) => row.panelId)).toEqual(["p1"]);
    } finally {
      unregisterPanelKind("late.board");
    }
  });

  it("parks a report until the plugin reports something new, and drops rows on revoke", () => {
    grant("acme");
    seedPanels({ p1: { title: "Board", kind: "acme.board", worktreeId: "wt-1" } });
    usePluginPanelActivityStore.setState({
      activityByPanelId: { p1: { acme: { state: "waiting", revision: 4 } } },
    });
    const { result } = renderHook(() => usePluginPanelAttentionRows());

    act(() => usePluginPanelAttentionStore.getState().park("p1", "acme", 4));
    expect(result.current[0]?.band).toBe("parked");

    act(() =>
      usePluginPanelActivityStore.setState({
        activityByPanelId: { p1: { acme: { state: "waiting", revision: 5 } } },
      })
    );
    expect(result.current[0]?.band).toBe("needs-you");

    act(() => grant());
    expect(result.current).toEqual([]);
  });

  it("survives a title carrying any character", () => {
    grant("acme");
    const title = 'Odd \u0000 "title" \u0001 ]';
    seedPanels({ p1: { title, kind: "acme.board" } });
    usePluginPanelActivityStore.setState({
      activityByPanelId: { p1: { acme: { state: "working", revision: 1 } } },
    });
    const { result } = renderHook(() => usePluginPanelAttentionRows());
    expect(result.current[0]).toMatchObject({ panelId: "p1", title });
  });

  it("keeps each project's instance of a plugin to its own grant", () => {
    const projectA = "project__proj-a__acme.board";
    const projectB = "project__proj-b__acme.board";
    registerKind("project:proj-a/acme.board/board", projectA);
    registerKind("project:proj-b/acme.board/board", projectB);
    try {
      grant(projectA);
      seedPanels({
        a: { title: "A", kind: "project:proj-a/acme.board/board" },
        b: { title: "B", kind: "project:proj-b/acme.board/board" },
      });
      usePluginPanelActivityStore.setState({
        activityByPanelId: {
          a: { [projectA]: { state: "waiting", revision: 1 } },
          b: { [projectB]: { state: "waiting", revision: 2 } },
        },
      });
      const { result } = renderHook(() => usePluginPanelAttentionRows());
      expect(result.current.map((row) => row.panelId)).toEqual(["a"]);
      // Named by its manifest id, never the machine-local instance key.
      expect(result.current[0]?.pluginName).toBe("acme.board");
    } finally {
      unregisterPanelKind("project:proj-a/acme.board/board");
      unregisterPanelKind("project:proj-b/acme.board/board");
    }
  });
});
