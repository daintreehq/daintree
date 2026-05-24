import { beforeEach, describe, expect, it } from "vitest";
import type { TerminalInstance } from "@shared/types";
import { _resetSelectorCacheForTests, getNarrowPanel, getNarrowPanels } from "../selectors";

// Adapter selectors that narrow the legacy `TerminalInstance` carrier to the
// `PanelInstance` union via the kind type guards (#8957). A missing `kind`
// defaults to "terminal", matching the guard convention.

function panel(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid",
    ...overrides,
  } as TerminalInstance;
}

beforeEach(() => {
  _resetSelectorCacheForTests();
});

describe("getNarrowPanel", () => {
  it("returns undefined for an unknown id", () => {
    expect(getNarrowPanel({}, "missing")).toBeUndefined();
  });

  it("narrows a terminal panel to the PTY variant", () => {
    const p = getNarrowPanel({ t: panel("t") }, "t");
    expect(p?.kind).toBe("terminal");
  });

  it("treats a record with no kind as a PTY panel", () => {
    const noKind = panel("t", { kind: undefined });
    const p = getNarrowPanel({ t: noKind }, "t");
    expect(p?.kind).toBeUndefined();
    expect(p).toBe(noKind);
  });

  it("narrows a browser panel", () => {
    const p = getNarrowPanel({ b: panel("b", { kind: "browser" }) }, "b");
    expect(p?.kind).toBe("browser");
  });

  it("narrows a dev-preview panel", () => {
    const p = getNarrowPanel({ d: panel("d", { kind: "dev-preview" }) }, "d");
    expect(p?.kind).toBe("dev-preview");
  });

  it("narrows a review panel", () => {
    const p = getNarrowPanel({ r: panel("r", { kind: "review" }) }, "r");
    expect(p?.kind).toBe("review");
  });
});

describe("getNarrowPanels", () => {
  it("returns an empty array for empty ids", () => {
    expect(getNarrowPanels({}, [])).toEqual([]);
  });

  it("preserves order and skips absent ids", () => {
    const byId = { a: panel("a"), b: panel("b", { kind: "browser" }) };
    const result = getNarrowPanels(byId, ["b", "missing", "a"]);
    expect(result.map((p) => p.id)).toEqual(["b", "a"]);
    expect(result.map((p) => p.kind)).toEqual(["browser", "terminal"]);
  });

  it("returns a stable reference when inputs are identity-equal", () => {
    const byId = { a: panel("a") };
    const ids = ["a"];
    const first = getNarrowPanels(byId, ids);
    const second = getNarrowPanels(byId, ids);
    expect(second).toBe(first);
  });

  it("recomputes when panelsById identity changes", () => {
    const ids = ["a"];
    const first = getNarrowPanels({ a: panel("a") }, ids);
    const second = getNarrowPanels({ a: panel("a") }, ids);
    expect(second).not.toBe(first);
    expect(second.map((p) => p.id)).toEqual(["a"]);
  });
});
