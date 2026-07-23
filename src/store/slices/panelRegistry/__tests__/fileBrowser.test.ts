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

  it("records an explicit false for the dotfile toggle", () => {
    setFileBrowserView("panel-1", { browserHideDotfiles: true });
    setFileBrowserView("panel-1", { browserHideDotfiles: false });

    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserHideDotfiles: false });
  });

  it("collapses and re-opens the sidebar", () => {
    setFileBrowserView("panel-1", { browserSidebarCollapsed: true });
    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserSidebarCollapsed: true });

    // Re-opening after collapse still writes a new record; the serializer is
    // what strips `false` back out of the persisted snapshot, not the store.
    const collapsed = store.get().panelsById["panel-1"];
    setFileBrowserView("panel-1", { browserSidebarCollapsed: false });
    expect(store.get().panelsById["panel-1"]).not.toBe(collapsed);
    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserSidebarCollapsed: false });
  });

  it("treats collapsing an already-open panel with false as a no-op", () => {
    // `false` and absent are the same open state, so patching `false` onto a
    // panel that never collapsed must not churn a fresh object every render.
    const before = store.get().panelsById["panel-1"];

    setFileBrowserView("panel-1", { browserSidebarCollapsed: false });

    expect(store.get().panelsById["panel-1"]).toBe(before);
  });

  it("stores a tree snapshot and treats a deep-equal recapture as a no-op (#11367)", () => {
    const snapshot = {
      worktreeId: "wt-1",
      rootPath: "",
      listings: [{ dirPath: "", nodes: [{ name: "src", path: "src", isDirectory: true }] }],
    };
    setFileBrowserView("panel-1", { browserTreeSnapshot: snapshot });
    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserTreeSnapshot: snapshot });

    // Capture builds a fresh object on every hide; identical content must not
    // dirty the panel entry (and with it the persisted layout).
    const before = store.get().panelsById["panel-1"];
    setFileBrowserView("panel-1", {
      browserTreeSnapshot: structuredClone(snapshot),
    });
    expect(store.get().panelsById["panel-1"]).toBe(before);

    // Real structural change writes.
    setFileBrowserView("panel-1", {
      browserTreeSnapshot: {
        ...snapshot,
        listings: [{ dirPath: "", nodes: [] }],
      },
    });
    expect(store.get().panelsById["panel-1"]).not.toBe(before);
  });

  it("preserves other browser fields when the sidebar collapses", () => {
    setFileBrowserView("panel-1", { browserSelectedPath: "src/app.ts" });
    setFileBrowserView("panel-1", { browserSidebarCollapsed: true });

    expect(store.get().panelsById["panel-1"]).toMatchObject({
      browserSidebarCollapsed: true,
      browserSelectedPath: "src/app.ts",
      browserExpandedPaths: ["src"],
    });
  });

  it("stores a dragged width and resets it back to the default", () => {
    setFileBrowserView("panel-1", { browserSidebarWidth: 420 });
    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserSidebarWidth: 420 });

    // Reset writes the explicit default; the serializer, not the store, is what
    // strips 288 back out of the persisted snapshot.
    const resized = store.get().panelsById["panel-1"];
    setFileBrowserView("panel-1", { browserSidebarWidth: 288 });
    expect(store.get().panelsById["panel-1"]).not.toBe(resized);
    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserSidebarWidth: 288 });
  });

  it("treats resetting a never-resized panel to the default width as a no-op", () => {
    // Absent width and 288 are the same state, so a double-click reset on a panel
    // that never resized must not churn a fresh object every render.
    const before = store.get().panelsById["panel-1"];

    setFileBrowserView("panel-1", { browserSidebarWidth: 288 });

    expect(store.get().panelsById["panel-1"]).toBe(before);
  });

  it("treats a width identical to the current one as a no-op", () => {
    setFileBrowserView("panel-1", { browserSidebarWidth: 420 });
    const resized = store.get().panelsById["panel-1"];

    setFileBrowserView("panel-1", { browserSidebarWidth: 420 });

    expect(store.get().panelsById["panel-1"]).toBe(resized);
  });

  it("clamps an out-of-range width into the allowed bounds before storing", () => {
    setFileBrowserView("panel-1", { browserSidebarWidth: 5000 });
    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserSidebarWidth: 600 });

    setFileBrowserView("panel-1", { browserSidebarWidth: 50 });
    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserSidebarWidth: 200 });
  });

  it("ignores a non-finite width rather than storing NaN and churning", () => {
    // NaN is valid under TS's `number`, but `NaN === NaN` is false, so storing it
    // would re-create the panel object (and re-persist) on every write and render
    // an invalid inline width. The chokepoint must treat it as a no-op.
    setFileBrowserView("panel-1", { browserSidebarWidth: 400 });
    const stored = store.get().panelsById["panel-1"];

    setFileBrowserView("panel-1", { browserSidebarWidth: Number.NaN });
    expect(store.get().panelsById["panel-1"]).toBe(stored);
    expect(store.get().panelsById["panel-1"]).toMatchObject({ browserSidebarWidth: 400 });

    setFileBrowserView("panel-1", { browserSidebarWidth: Number.POSITIVE_INFINITY });
    expect(store.get().panelsById["panel-1"]).toBe(stored);
  });

  it("preserves selection and expansion when the width changes", () => {
    setFileBrowserView("panel-1", { browserSelectedPath: "src/app.ts" });
    setFileBrowserView("panel-1", { browserSidebarWidth: 400 });

    expect(store.get().panelsById["panel-1"]).toMatchObject({
      browserSidebarWidth: 400,
      browserSelectedPath: "src/app.ts",
      browserExpandedPaths: ["src"],
    });
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
