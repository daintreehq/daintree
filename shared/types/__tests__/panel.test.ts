import { describe, it, expect } from "vitest";
import {
  isBuiltInPanelKind,
  isBrowserPanel,
  isDevPreviewPanel,
  isDockPanel,
  isGridPanelLocation,
  isPtyPanel,
  type PanelInstance,
  type PanelLocation,
  type TerminalInstance,
} from "../panel.js";
import { BUILT_IN_PANEL_KINDS } from "../../config/panelKindRegistry.js";

describe("isBuiltInPanelKind", () => {
  // Hard-coded positives — kept independent of BUILT_IN_PANEL_KINDS so a
  // wrong/incomplete SSOT still gets caught here.
  it.each(["terminal", "browser", "dev-preview"])("returns true for %s", (kind) => {
    expect(isBuiltInPanelKind(kind)).toBe(true);
  });

  it("returns true for every entry in BUILT_IN_PANEL_KINDS", () => {
    for (const kind of BUILT_IN_PANEL_KINDS) {
      expect(isBuiltInPanelKind(kind)).toBe(true);
    }
  });

  it("returns false for unknown kinds and extension kinds", () => {
    expect(isBuiltInPanelKind("agent")).toBe(false);
    expect(isBuiltInPanelKind("ext-plugin.viewer")).toBe(false);
    expect(isBuiltInPanelKind("")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(isBuiltInPanelKind("Terminal")).toBe(false);
    expect(isBuiltInPanelKind("DEV-PREVIEW")).toBe(false);
  });
});

describe("isGridPanelLocation", () => {
  it("treats only grid and undefined as grid members", () => {
    expect(isGridPanelLocation("grid")).toBe(true);
    // Legacy panels persisted before the location field existed.
    expect(isGridPanelLocation(undefined)).toBe(true);
  });

  it("excludes dock, overlay, trash, and background from the grid", () => {
    expect(isGridPanelLocation("dock")).toBe(false);
    // overlay = Daintree Assistant; must never be counted as a grid member (#9699).
    expect(isGridPanelLocation("overlay")).toBe(false);
    expect(isGridPanelLocation("trash")).toBe(false);
    expect(isGridPanelLocation("background")).toBe(false);
  });

  it("classifies every PanelLocation value (no value silently defaults to grid)", () => {
    const allLocations: PanelLocation[] = ["grid", "dock", "overlay", "trash", "background"];
    const gridMembers = allLocations.filter((loc) => isGridPanelLocation(loc));
    // Exactly one concrete location ("grid") is a grid member; the rest are not.
    expect(gridMembers).toEqual(["grid"]);
  });
});

describe("panel variant guards", () => {
  const ptyPanel = { id: "p1", kind: "terminal", title: "t", location: "grid" } as PanelInstance;
  const browserPanel = { id: "p2", kind: "browser", title: "t", location: "grid" } as PanelInstance;
  const devPreviewPanel = {
    id: "p3",
    kind: "dev-preview",
    title: "t",
    location: "grid",
  } as PanelInstance;

  it("isPtyPanel matches only terminal", () => {
    expect(isPtyPanel(ptyPanel)).toBe(true);
    expect(isPtyPanel(browserPanel)).toBe(false);
    expect(isPtyPanel(devPreviewPanel)).toBe(false);
  });

  it("isBrowserPanel matches only browser", () => {
    expect(isBrowserPanel(ptyPanel)).toBe(false);
    expect(isBrowserPanel(browserPanel)).toBe(true);
    expect(isBrowserPanel(devPreviewPanel)).toBe(false);
  });

  it("isDevPreviewPanel matches only dev-preview", () => {
    expect(isDevPreviewPanel(ptyPanel)).toBe(false);
    expect(isDevPreviewPanel(browserPanel)).toBe(false);
    expect(isDevPreviewPanel(devPreviewPanel)).toBe(true);
  });

  it("legacy TerminalInstance with absent kind defaults to terminal", () => {
    const legacy: TerminalInstance = {
      id: "legacy",
      title: "old",
      location: "grid",
    };
    expect(isPtyPanel(legacy)).toBe(true);
    expect(isBrowserPanel(legacy)).toBe(false);
    expect(isDevPreviewPanel(legacy)).toBe(false);
  });

  it("isDockPanel admits PTY, file, and browser panels but not dev-preview/review", () => {
    // The dock render path only surfaces panels isDockPanel recognizes; browser
    // must be admitted or it vanishes when moved to the dock (#11053).
    const filePanel = { id: "p4", kind: "file", title: "t", location: "dock" } as PanelInstance;
    const reviewPanel = { id: "p5", kind: "review", title: "t", location: "grid" } as PanelInstance;
    expect(isDockPanel(ptyPanel)).toBe(true);
    expect(isDockPanel(browserPanel)).toBe(true);
    expect(isDockPanel(filePanel)).toBe(true);
    expect(isDockPanel(devPreviewPanel)).toBe(false);
    expect(isDockPanel(reviewPanel)).toBe(false);
  });
});
