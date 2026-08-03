import { beforeEach, describe, expect, it } from "vitest";
import type { PanelInstance } from "@shared/types/panel";
import {
  _resetSelectorCacheForTests,
  getNarrowPanel,
  getNarrowPanels,
  getRenderablePanel,
  isPanelRenderEligible,
  selectHasMultipleSessionLost,
} from "../selectors";

// Adapter selectors that narrow the legacy `TerminalInstance` carrier to the
// `PanelInstance` union via the kind type guards (#8957). A missing `kind`
// defaults to "terminal", matching the guard convention.

function panel(id: string, overrides: Partial<PanelInstance> = {}): PanelInstance {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid",
    ...overrides,
  } as PanelInstance;
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

  // No-kind legacy records are no longer representable on the carrier
  // (#8957 step 5 flipped `panelsById` to `Record<string, PanelInstance>`,
  // which requires a discriminant). The backfill branch was removed.

  it("preserves identity for a record that already carries kind: terminal", () => {
    const withKind = panel("t");
    const p = getNarrowPanel({ t: withKind }, "t");
    expect(p).toBe(withKind);
  });

  it("returns undefined for an extension/unknown kind", () => {
    const ext = panel("x", { kind: "acme.tool" as unknown as PanelInstance["kind"] });
    expect(getNarrowPanel({ x: ext }, "x")).toBeUndefined();
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

describe("isPanelRenderEligible (#10512)", () => {
  it("treats every built-in kind as renderable", () => {
    for (const kind of ["terminal", "browser", "dev-preview", "review"] as const) {
      expect(isPanelRenderEligible(panel(kind, { kind }))).toBe(true);
    }
  });

  it("treats a plugin panel carrying a pluginId as renderable", () => {
    const p = panel("x", {
      kind: "acme.notes" as unknown as PanelInstance["kind"],
      pluginId: "acme",
    });
    expect(isPanelRenderEligible(p)).toBe(true);
  });

  it("treats a dotted plugin kind without a pluginId as renderable (disabled-plugin hatch)", () => {
    const p = panel("x", { kind: "acme.notes" as unknown as PanelInstance["kind"] });
    expect(isPanelRenderEligible(p)).toBe(true);
  });

  it("excludes an unknown, undotted kind with no pluginId", () => {
    const p = panel("x", { kind: "garbage" as unknown as PanelInstance["kind"] });
    expect(isPanelRenderEligible(p)).toBe(false);
  });
});

describe("getRenderablePanel (#10512)", () => {
  it("returns undefined for an absent id", () => {
    expect(getRenderablePanel({}, "missing")).toBeUndefined();
  });

  it("returns built-in panels just like getNarrowPanel", () => {
    const b = panel("b", { kind: "browser" });
    expect(getRenderablePanel({ b }, "b")).toBe(b);
  });

  it("returns a plugin panel that getNarrowPanel drops", () => {
    const ext = panel("x", {
      kind: "acme.notes" as unknown as PanelInstance["kind"],
      pluginId: "acme",
    });
    // Regression guard: the type-narrowing read path still drops it...
    expect(getNarrowPanel({ x: ext }, "x")).toBeUndefined();
    // ...but the grid render-eligibility path keeps it.
    expect(getRenderablePanel({ x: ext }, "x")).toBe(ext);
  });

  it("drops an unknown, undotted kind with no pluginId", () => {
    const junk = panel("x", { kind: "garbage" as unknown as PanelInstance["kind"] });
    expect(getRenderablePanel({ x: junk }, "x")).toBeUndefined();
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

  it("drops extension/unknown-kind panels from the result", () => {
    const byId = {
      a: panel("a"),
      x: panel("x", { kind: "acme.tool" as unknown as PanelInstance["kind"] }),
    };
    const result = getNarrowPanels(byId, ["a", "x"]);
    expect(result.map((p) => p.id)).toEqual(["a"]);
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

// Gate for the banner's "Dismiss all" control (#11589). Scans the carrier
// rather than an ordered id list so a hydration batch that hasn't appended its
// ids yet still counts — the post-restart burst this control exists for.
describe("selectHasMultipleSessionLost", () => {
  const lost = (id: string, overrides: Partial<PanelInstance> = {}) =>
    panel(id, { sessionLostOnRestore: true, ...overrides } as Partial<PanelInstance>);

  it("is false with no flagged panels", () => {
    expect(selectHasMultipleSessionLost({ a: panel("a"), b: panel("b") })).toBe(false);
  });

  it("is false with exactly one flagged panel", () => {
    expect(selectHasMultipleSessionLost({ a: lost("a"), b: panel("b") })).toBe(false);
  });

  it("is true with two flagged panels", () => {
    expect(selectHasMultipleSessionLost({ a: lost("a"), b: lost("b") })).toBe(true);
  });

  it("counts flagged panels across different worktrees", () => {
    expect(
      selectHasMultipleSessionLost({
        a: lost("a", { worktreeId: "wt-1" }),
        b: lost("b", { worktreeId: "wt-2" }),
      })
    ).toBe(true);
  });

  it("ignores non-PTY panels carrying the field", () => {
    expect(
      selectHasMultipleSessionLost({
        a: lost("a"),
        b: lost("b", { kind: "browser" }),
      })
    ).toBe(false);
  });

  // The store replaces `panelsById` on every write, so identity change is the
  // only invalidation signal the memo needs.
  it("recomputes when the carrier identity changes", () => {
    expect(selectHasMultipleSessionLost({ a: lost("a"), b: lost("b") })).toBe(true);
    expect(selectHasMultipleSessionLost({ a: lost("a") })).toBe(false);
    expect(selectHasMultipleSessionLost({ a: lost("a"), b: lost("b"), c: lost("c") })).toBe(true);
  });
});
