// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

vi.mock("@/store", async () => {
  const { usePanelStore } = await import("@/store/panelStore");
  return { usePanelStore };
});

import {
  createGridGroupPanelsSelector,
  createGridPanelSelector,
  isSameRenderedPanel,
  useGridGroupPanels,
  useGridPanel,
} from "../gridPanelSelection";
import { usePanelStore } from "@/store/panelStore";

function pty(id: string, fields: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    flowStatus: "running",
    flowStatusTimestamp: 1,
    ...fields,
  };
}

function state(...panels: PanelInstance[]) {
  return { panelsById: Object.fromEntries(panels.map((p) => [p.id, p])) };
}

const ids = (panels: PanelInstance[]) => panels.map((p) => p.id);

describe("isSameRenderedPanel", () => {
  const base = pty("a", { agentState: "working" });

  it.each<[string, Partial<PtyPanelData>]>([
    ["the flow ordering timestamp", { flowStatusTimestamp: 9 }],
    ["the held-duration gauge", { heldDurationMs: 4_000 }],
    ["the last agent observation", { lastAgentObservation: { agentState: "working", at: 7 } }],
    [
      "all bookkeeping at once",
      {
        flowStatusTimestamp: 9,
        heldDurationMs: 2_000,
        lastAgentObservation: { agentState: "working", at: 7 },
      },
    ],
  ])("ignores %s", (_name, fields) => {
    expect(isSameRenderedPanel(base, { ...base, ...fields })).toBe(true);
  });

  it("ignores the held-duration gauge being cleared, either way round", () => {
    const held = pty("a", { heldDurationMs: 2_000 });
    const { heldDurationMs: _gauge, ...cleared } = held;
    expect(isSameRenderedPanel(held, cleared)).toBe(true);
    expect(isSameRenderedPanel(cleared, held)).toBe(true);
    expect(isSameRenderedPanel(held, { ...held, heldDurationMs: undefined })).toBe(true);
  });

  it.each<[string, Partial<PtyPanelData>]>([
    ["a visible field", { agentState: "waiting" }],
    ["a visible field beside bookkeeping", { agentState: "waiting", flowStatusTimestamp: 9 }],
    ["a visible field added", { exitCode: 0 }],
    ["a visible field added as undefined", { exitCode: undefined }],
  ])("tells apart %s", (_name, fields) => {
    expect(isSameRenderedPanel(base, { ...base, ...fields })).toBe(false);
  });

  it("tells apart a nested object replaced with an equal one", () => {
    const withState = pty("a", { extensionState: {} });
    expect(isSameRenderedPanel(withState, { ...withState, extensionState: {} })).toBe(false);
  });

  it("tells apart a visible field removed", () => {
    const { agentState: _removed, ...rest } = base;
    expect(isSameRenderedPanel(base, rest)).toBe(false);
    expect(isSameRenderedPanel(rest, base)).toBe(false);
  });
});

describe("createGridPanelSelector", () => {
  it("keeps the panel it returned through bookkeeping-only writes", () => {
    const select = createGridPanelSelector("a");
    const first = pty("a");
    expect(select(state(first))).toBe(first);
    expect(select(state(pty("a", { flowStatusTimestamp: 5 })))).toBe(first);
    expect(select(state(pty("a", { heldDurationMs: 2_000 })))).toBe(first);
  });

  it("returns the new panel once a visible field changes", () => {
    const select = createGridPanelSelector("a");
    select(state(pty("a")));
    const renamed = pty("a", { title: "Renamed", flowStatusTimestamp: 5 });
    expect(select(state(renamed))).toBe(renamed);
    expect(select(state(pty("a", { title: "Renamed", flowStatusTimestamp: 6 })))).toBe(renamed);
  });

  it("follows a panel removed and recreated", () => {
    const select = createGridPanelSelector("a");
    select(state(pty("a")));
    expect(select(state())).toBeUndefined();
    const recreated = pty("a");
    expect(select(state(recreated))).toBe(recreated);
  });

  it("keeps a cache per selector", () => {
    const one = createGridPanelSelector("a");
    const two = createGridPanelSelector("a");
    const first = pty("a");
    const second = pty("a", { flowStatusTimestamp: 2 });
    expect(one(state(first))).toBe(first);
    expect(two(state(second))).toBe(second);
    expect(one(state(second))).toBe(first);
  });
});

describe("createGridGroupPanelsSelector", () => {
  it("keeps the array it returned through bookkeeping-only writes", () => {
    const select = createGridGroupPanelsSelector(["a", "b"]);
    const first = select(state(pty("a"), pty("b")));
    expect(ids(first)).toEqual(["a", "b"]);
    expect(
      select(state(pty("a", { heldDurationMs: 2_000 }), pty("b", { flowStatusTimestamp: 3 })))
    ).toBe(first);
  });

  it("reuses the unchanged panels when one changes", () => {
    const select = createGridGroupPanelsSelector(["a", "b"]);
    const [a] = select(state(pty("a"), pty("b")));
    const renamed = pty("b", { title: "Renamed" });
    const next = select(state(pty("a", { flowStatusTimestamp: 4 }), renamed));
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(renamed);
  });

  it("follows panels leaving and rejoining the group's renderable set", () => {
    const select = createGridGroupPanelsSelector(["a", "b"]);
    const both = select(state(pty("a"), pty("b")));
    expect(ids(select(state(pty("b"))))).toEqual(["b"]);
    expect(ids(select(state(pty("a"), pty("b"))))).toEqual(["a", "b"]);
    const leading = select(state(pty("a")));
    expect(ids(leading)).toEqual(["a"]);
    expect(leading).not.toBe(both);
    const none = select(state());
    expect(none).toEqual([]);
    expect(none).not.toBe(leading);
  });

  it("keeps a plugin-contributed panel in the group", () => {
    const select = createGridGroupPanelsSelector(["a", "p"]);
    // A dotted plugin kind the carrier's types don't name.
    const plugin: PanelInstance = Object.assign(pty("p"), { kind: "acme.board", pluginId: "acme" });
    expect(ids(select(state(pty("a"), plugin)))).toEqual(["a", "p"]);
  });

  it("returns the group's order", () => {
    const select = createGridGroupPanelsSelector(["b", "a"]);
    expect(ids(select(state(pty("a"), pty("b"))))).toEqual(["b", "a"]);
  });
});

describe("the hooks", () => {
  const initial = usePanelStore.getState();

  function seed(...panels: PanelInstance[]) {
    act(() => {
      usePanelStore.setState({ ...state(...panels), panelIds: ids(panels) });
    });
  }

  afterEach(() => {
    usePanelStore.setState(initial, true);
  });

  it("follows the cell to another panel", () => {
    seed(pty("a"), pty("b"));
    const { result, rerender } = renderHook(({ id }) => useGridPanel(id), {
      initialProps: { id: "a" },
    });
    expect(result.current?.id).toBe("a");
    rerender({ id: "b" });
    expect(result.current?.id).toBe("b");
  });

  it("keeps the group's panels through a fresh array of the same ids", () => {
    seed(pty("a"), pty("b"));
    const { result, rerender } = renderHook(({ panelIds }) => useGridGroupPanels(panelIds), {
      initialProps: { panelIds: ["a", "b"] },
    });
    const first = result.current;
    rerender({ panelIds: ["a", "b"] });
    expect(result.current).toBe(first);
    seed(pty("a", { flowStatusTimestamp: 7 }), pty("b"));
    expect(result.current).toBe(first);
  });

  it("follows the group's new order and membership", () => {
    seed(pty("a"), pty("b"), pty("c"));
    const { result, rerender } = renderHook(({ panelIds }) => useGridGroupPanels(panelIds), {
      initialProps: { panelIds: ["a", "b"] },
    });
    rerender({ panelIds: ["b", "a"] });
    expect(ids(result.current)).toEqual(["b", "a"]);
    rerender({ panelIds: ["b", "a", "c"] });
    expect(ids(result.current)).toEqual(["b", "a", "c"]);
  });
});
