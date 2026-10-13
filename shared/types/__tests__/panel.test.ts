import { afterEach, describe, it, expect } from "vitest";
import { clearPanelKindRegistry, registerPanelKind } from "../../config/panelKindRegistry.js";
import {
  isBuiltInPanelKind,
  isBrowserPanel,
  isDevPreviewPanel,
  isDockPanel,
  isGridPanelLocation,
  isPtyPanel,
  type PanelInstance,
  type TerminalInstance,
} from "../panel.js";

describe("isBuiltInPanelKind", () => {
  // Hard-coded positives — kept independent of BUILT_IN_PANEL_KINDS so a
  // wrong/incomplete SSOT still gets caught here.
  it.each(["terminal", "browser", "dev-preview"])("returns true for %s", (kind) => {
    expect(isBuiltInPanelKind(kind)).toBe(true);
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

describe("isDockPanel — plugin kinds follow the registry", () => {
  afterEach(() => clearPanelKindRegistry());

  it("tracks plugin registration and changes to its dockable policy", () => {
    const panel: TerminalInstance = {
      id: "plugin-panel",
      kind: "ext-a.viewer",
      title: "Viewer",
      location: "dock",
      pluginId: "ext-a",
    };
    const config = {
      id: "ext-a.viewer",
      name: "Viewer",
      iconId: "puzzle",
      color: "#123456",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "ext-a",
    };

    expect(isDockPanel(panel)).toBe(false);
    registerPanelKind(config);
    expect(isDockPanel(panel)).toBe(true);
    registerPanelKind({ ...config, dockable: false });
    expect(isDockPanel(panel)).toBe(false);
    clearPanelKindRegistry();
    expect(isDockPanel(panel)).toBe(false);
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

  it("isDockPanel admits dockable built-in kinds but not the opt-outs", () => {
    // Membership follows the registry (`panelKindIsDockable`), not a fixed kind
    // list: terminal/file/browser/file-browser/dev-preview are dockable by
    // default; the two kinds that declare `dockable: false` are excluded, or
    // they vanish from the dock.
    const filePanel = { id: "p4", kind: "file", title: "t", location: "dock" } as PanelInstance;
    const fileBrowserPanel = {
      id: "p5",
      kind: "file-browser",
      title: "t",
      location: "dock",
    } as PanelInstance;
    expect(isDockPanel(ptyPanel)).toBe(true);
    expect(isDockPanel(browserPanel)).toBe(true);
    expect(isDockPanel(filePanel)).toBe(true);
    expect(isDockPanel(fileBrowserPanel)).toBe(true);
    const devPreviewPanel = {
      id: "p6",
      kind: "dev-preview",
      title: "t",
      location: "dock",
    } as PanelInstance;
    expect(isDockPanel(devPreviewPanel)).toBe(true);
    for (const kind of ["review", "diff"]) {
      const panel = { id: `opt-${kind}`, kind, title: "t", location: "grid" } as PanelInstance;
      expect(isDockPanel(panel), `${kind} opts out of the dock`).toBe(false);
    }
  });
});
