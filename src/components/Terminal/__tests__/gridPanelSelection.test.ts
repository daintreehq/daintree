import { describe, expect, it } from "vitest";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import {
  createGridGroupPanelsSelector,
  createGridPanelSelector,
  isSameRenderedPanel,
} from "../gridPanelSelection";

function pty(id: string, fields: Partial<PtyPanelData> = {}): PanelInstance {
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
  } as PanelInstance;
}

function state(...panels: PanelInstance[]) {
  return { panelsById: Object.fromEntries(panels.map((p) => [p.id, p])) };
}

describe("isSameRenderedPanel", () => {
  const base = pty("a", { agentState: "working" });

  it.each<[string, Partial<PtyPanelData>]>([
    ["the flow ordering timestamp", { flowStatusTimestamp: 9 }],
    ["the held-duration gauge", { heldDurationMs: 4_000 }],
    ["a cleared held-duration gauge", { heldDurationMs: undefined }],
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
    expect(isSameRenderedPanel(base, { ...base, ...fields } as PanelInstance)).toBe(true);
  });

  it.each<[string, Partial<PtyPanelData>]>([
    ["a visible field", { agentState: "waiting" }],
    ["a visible field beside bookkeeping", { agentState: "waiting", flowStatusTimestamp: 9 }],
    ["a visible field added", { exitCode: 0 }],
    ["a visible field added as undefined", { exitCode: undefined }],
  ])("tells apart %s", (_name, fields) => {
    expect(isSameRenderedPanel(base, { ...base, ...fields } as PanelInstance)).toBe(false);
  });

  it("tells apart a nested object replaced with an equal one", () => {
    const withState = pty("a", { extensionState: {} });
    expect(
      isSameRenderedPanel(withState, { ...withState, extensionState: {} } as PanelInstance)
    ).toBe(false);
  });

  it("tells apart a visible field removed", () => {
    const { agentState: _removed, ...rest } = base as PtyPanelData;
    expect(isSameRenderedPanel(base, rest as PanelInstance)).toBe(false);
    expect(isSameRenderedPanel(rest as PanelInstance, base)).toBe(false);
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
    expect(first.map((p) => p.id)).toEqual(["a", "b"]);
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

  it("follows panels leaving the group's renderable set", () => {
    const select = createGridGroupPanelsSelector(["a", "b"]);
    select(state(pty("a"), pty("b")));
    expect(select(state(pty("b"))).map((p) => p.id)).toEqual(["b"]);
    expect(select(state(pty("a"), pty("b"))).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("keeps a plugin-contributed panel in the group", () => {
    const select = createGridGroupPanelsSelector(["a", "p"]);
    const plugin = {
      id: "p",
      kind: "acme.board",
      title: "Board",
      location: "grid",
    } as PanelInstance;
    expect(select(state(pty("a"), plugin)).map((p) => p.id)).toEqual(["a", "p"]);
  });

  it("returns the group's order", () => {
    const select = createGridGroupPanelsSelector(["b", "a"]);
    expect(select(state(pty("a"), pty("b"))).map((p) => p.id)).toEqual(["b", "a"]);
  });
});
