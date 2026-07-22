import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelInstance } from "@shared/types/panel";
import { createFileBrowserPanelActions } from "../fileBrowser";

vi.mock("../persistence", () => ({ saveNormalized: vi.fn() }));

interface TestState {
  panelsById: Record<string, PanelInstance>;
  panelIds: string[];
}

/**
 * Minimal stand-in for zustand's `set`, recording whether the updater returned
 * a new state object. A returned-unchanged state is what "bail on a no-op"
 * means at this layer, so the tests assert on identity rather than on a mock
 * call count.
 */
function makeSet(initial: TestState) {
  let state = initial;
  const set = ((updater: (current: TestState) => Partial<TestState> | TestState) => {
    const result = updater(state);
    if (result === state) return;
    state = { ...state, ...result };
  }) as never;
  return { set, get: () => state };
}

function browserPanel(overrides: Partial<Extract<PanelInstance, { kind: "file-browser" }>> = {}) {
  return {
    id: "panel-1",
    title: "Files",
    location: "grid" as const,
    kind: "file-browser" as const,
    ...overrides,
  };
}

describe("setFileBrowserView", () => {
  let store: ReturnType<typeof makeSet>;
  let setFileBrowserView: ReturnType<typeof createFileBrowserPanelActions>["setFileBrowserView"];

  beforeEach(() => {
    store = makeSet({
      panelsById: { "panel-1": browserPanel({ browserExpandedPaths: ["src"] }) },
      panelIds: ["panel-1"],
    });
    setFileBrowserView = createFileBrowserPanelActions(store.set).setFileBrowserView;
  });

  it("applies only the fields named in the patch", () => {
    setFileBrowserView("panel-1", { browserSelectedPath: "src/app.ts" });

    const panel = store.get().panelsById["panel-1"];
    expect(panel).toMatchObject({
      browserSelectedPath: "src/app.ts",
      browserExpandedPaths: ["src"],
    });
  });

  it("writes selection and expansion together in one commit", () => {
    // Keyboard expand moves the selection at the same time; two sequential
    // writes would persist a state where the selected row isn't in the tree.
    setFileBrowserView("panel-1", {
      browserSelectedPath: "src/lib/util.ts",
      browserExpandedPaths: ["src", "src/lib"],
    });

    expect(store.get().panelsById["panel-1"]).toMatchObject({
      browserSelectedPath: "src/lib/util.ts",
      browserExpandedPaths: ["src", "src/lib"],
    });
  });

  it("leaves the panel object identical when nothing actually changes", () => {
    const before = store.get().panelsById["panel-1"];

    setFileBrowserView("panel-1", { browserExpandedPaths: ["src"] });

    // A fresh object here would re-render every panel-store subscriber and
    // re-write the persisted snapshot on every arrow key.
    expect(store.get().panelsById["panel-1"]).toBe(before);
  });

  it("treats a reordered expansion list as a real change", () => {
    const before = store.get().panelsById["panel-1"];

    setFileBrowserView("panel-1", { browserExpandedPaths: ["src", "docs"] });

    expect(store.get().panelsById["panel-1"]).not.toBe(before);
  });

  it("sets and clears the browse root", () => {
    setFileBrowserView("panel-1", { browserRootPath: "src/panels" });
    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserRootPath: "src/panels" });

    setFileBrowserView("panel-1", { browserRootPath: "" });
    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserRootPath: "" });
  });

  it("treats resetting a never-rooted panel as a no-op", () => {
    // "" and absent are both "the worktree root" — writing "" onto a panel
    // that never had a root would persist a snapshot for nothing.
    const before = store.get().panelsById["panel-1"];

    setFileBrowserView("panel-1", { browserRootPath: "" });

    expect(store.get().panelsById["panel-1"]).toBe(before);
  });

  it("records an explicit false for the ignored toggle", () => {
    setFileBrowserView("panel-1", { browserShowIgnored: true });
    setFileBrowserView("panel-1", { browserShowIgnored: false });

    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserShowIgnored: false });
  });

  it("ignores a panel of another kind rather than stamping browser fields onto it", () => {
    const other = makeSet({
      panelsById: {
        "panel-1": { id: "panel-1", title: "Diff", location: "grid", kind: "diff" },
      },
      panelIds: ["panel-1"],
    });
    const action = createFileBrowserPanelActions(other.set).setFileBrowserView;
    const before = other.get().panelsById["panel-1"];

    action("panel-1", { browserSelectedPath: "src/app.ts" });

    expect(other.get().panelsById["panel-1"]).toBe(before);
  });

  it("is a no-op for a panel id that no longer exists", () => {
    const before = store.get();

    setFileBrowserView("missing", { browserSelectedPath: "src/app.ts" });

    expect(store.get()).toBe(before);
  });
});
