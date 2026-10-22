import { beforeEach, describe, expect, it, vi } from "vitest";

const storeState = vi.hoisted(() => ({ appTheme: {} as Record<string, unknown> }));
vi.mock("../../store.js", () => ({
  store: { get: vi.fn((key: string) => (key === "appTheme" ? storeState.appTheme : undefined)) },
}));

const setTitleBarOverlayTheme = vi.hoisted(() => vi.fn());
vi.mock("../titleBarOverlay.js", () => ({ setTitleBarOverlayTheme }));

vi.mock("electron", () => ({
  nativeTheme: { shouldUseDarkColors: true },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { repaintWindowTheme, visibleProjectIdOf } from "../projectThemeChrome.js";
import { resolveAppTheme } from "../../../shared/theme/index.js";

function source(active: string | null, bridgedFrom?: string | null) {
  return {
    isSwitchBridged: () => bridgedFrom !== undefined,
    getOutgoingBridgeProjectId: () => bridgedFrom ?? null,
    getActiveProjectId: () => active,
  };
}

function makeWindow() {
  return { isDestroyed: vi.fn(() => false), setBackgroundColor: vi.fn() };
}

describe("visibleProjectIdOf (#13833)", () => {
  it("is the active project outside a switch", () => {
    expect(visibleProjectIdOf(source("p1"))).toBe("p1");
    expect(visibleProjectIdOf(source(null))).toBeNull();
    expect(visibleProjectIdOf(null)).toBeNull();
  });

  it("stays with the outgoing project while it still covers the incoming one", () => {
    expect(visibleProjectIdOf(source("incoming", "outgoing"))).toBe("outgoing");
    // An unbound welcome view as the outgoing side shows the global theme.
    expect(visibleProjectIdOf(source("incoming", null))).toBeNull();
  });

  it("names a remote view's project by its bare id, as its renderer does", () => {
    expect(visibleProjectIdOf(source("host-1:p1"))).toBe("p1");
  });
});

describe("repaintWindowTheme (#13833)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.appTheme = {
      colorSchemeId: "daintree",
      projectThemes: { p1: { colorSchemeId: "bondi" } },
    };
  });

  it("paints the window in the project's own theme", () => {
    const win = makeWindow();
    repaintWindowTheme(win as never, "p1");
    const bondi = resolveAppTheme("bondi", []);
    expect(win.setBackgroundColor).toHaveBeenCalledWith(bondi.tokens["surface-canvas"]);
    expect(setTitleBarOverlayTheme).toHaveBeenCalledWith(win, bondi.tokens);
  });

  it("paints the global theme for a project without one, or no project", () => {
    const daintree = resolveAppTheme("daintree", []);
    for (const projectId of ["p2", null]) {
      const win = makeWindow();
      repaintWindowTheme(win as never, projectId);
      expect(win.setBackgroundColor).toHaveBeenCalledWith(daintree.tokens["surface-canvas"]);
    }
  });

  it("never throws into the caller over a colour Electron rejects", () => {
    const win = makeWindow();
    win.setBackgroundColor.mockImplementation(() => {
      throw new Error("bad colour");
    });
    expect(() => repaintWindowTheme(win as never, "p1")).not.toThrow();
  });

  it("leaves a destroyed window alone", () => {
    const win = makeWindow();
    win.isDestroyed.mockReturnValue(true);
    repaintWindowTheme(win as never, "p1");
    expect(win.setBackgroundColor).not.toHaveBeenCalled();
  });
});
