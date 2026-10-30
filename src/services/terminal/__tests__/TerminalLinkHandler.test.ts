// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));
const notify = vi.hoisted(() => vi.fn());
const addPanel = vi.hoisted(() => vi.fn(() => Promise.resolve("new")));
const setBrowserUrl = vi.hoisted(() => vi.fn<(id: string, url: string) => void>());
const activateTerminal = vi.hoisted(() => vi.fn<(id: string) => void>());
const setActiveTab = vi.hoisted(() => vi.fn<(groupId: string, panelId: string) => void>());
const getPanelGroup = vi.hoisted(() =>
  vi.fn<(panelId: string) => { id: string; panelIds: string[] } | undefined>()
);
const activatePluginUrlLink = vi.hoisted(() => vi.fn<(url: string, id: string) => boolean>());
const panelState = vi.hoisted(() => ({
  panelsById: {} as Record<string, unknown>,
  panelIds: [] as string[],
}));

vi.mock("@/clients", () => ({ systemClient: { openExternal: vi.fn() } }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/lib/platform", () => ({ isMac: () => true }));
vi.mock("../pluginTerminalLinks", () => ({ activatePluginUrlLink }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      ...panelState,
      addPanel,
      setBrowserUrl,
      activateTerminal,
      getPanelGroup,
      setActiveTab,
    }),
  },
}));

import { TerminalLinkHandler } from "../TerminalLinkHandler";

const forward = vi.fn();
const cmdClick = new MouseEvent("click", { metaKey: true });

function bindView(hostId: string | null): void {
  if (hostId === null) delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  else window.__DAINTREE_HOST_ID__ = { id: hostId };
}

beforeEach(() => {
  forward.mockReset();
  // The local port is taken, so the forward lands on another one.
  forward.mockImplementation(async ({ hostId, remotePort, origin }) => ({
    forwardId: "f1",
    hostId,
    remotePort,
    localPort: remotePort + 10_000,
    origin,
    label: null,
    createdAt: 1,
  }));
  dispatch.mockClear();
  activatePluginUrlLink.mockReset().mockReturnValue(false);
  notify.mockClear();
  addPanel.mockClear();
  setBrowserUrl.mockClear();
  activateTerminal.mockClear();
  setActiveTab.mockClear();
  getPanelGroup.mockReset().mockReturnValue(undefined);
  panelState.panelsById = { t1: { id: "t1", kind: "terminal", cwd: "/repo", worktreeId: "w1" } };
  panelState.panelIds = ["t1"];
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { portForwards: { forward } },
  });
});

afterEach(() => bindView(null));

describe("modifier-click on a host's localhost link", () => {
  it("opens a new panel at the host's address without forwarding the link first", () => {
    bindView("studio-01");
    new TerminalLinkHandler().openLink("http://localhost:5173/", "t1", cmdClick);
    expect(addPanel).toHaveBeenCalledWith({
      kind: "browser",
      browserUrl: "http://localhost:5173/",
      worktreeId: "w1",
      cwd: "/repo",
    });
    expect(forward).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("points an existing panel at the host's address and navigates it", () => {
    bindView("studio-01");
    panelState.panelsById.b1 = { id: "b1", kind: "browser", worktreeId: "w1" };
    panelState.panelIds = ["t1", "b1"];
    new TerminalLinkHandler().openLink("localhost:5173", "t1", cmdClick);
    expect(setBrowserUrl).toHaveBeenCalledWith("b1", "http://localhost:5173/");
    expect(activateTerminal).toHaveBeenCalledWith("b1");
    expect(dispatch).toHaveBeenCalledWith(
      "browser.navigate",
      { url: "http://localhost:5173/", terminalId: "b1" },
      { source: "user" }
    );
    expect(forward).not.toHaveBeenCalled();
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("forwards before opening externally when the source terminal is gone", async () => {
    bindView("studio-01");
    panelState.panelsById = {};
    new TerminalLinkHandler().openLink("http://localhost:5173/", "gone", cmdClick);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "http://localhost:15173/" },
      { source: "user" }
    );
    expect(addPanel).not.toHaveBeenCalled();
  });
});

describe("which browser pane a modifier-click reuses (#14965)", () => {
  function addBrowser(id: string, fields: Record<string, unknown> = {}): void {
    panelState.panelsById[id] = { id, kind: "browser", worktreeId: "w1", ...fields };
    panelState.panelIds = [...panelState.panelIds, id];
  }

  function navigatedPane(): string | undefined {
    new TerminalLinkHandler().openLink("http://localhost:5173/", "t1", cmdClick);
    return setBrowserUrl.mock.calls[0]?.[0];
  }

  it("takes the most recently used pane, not the first one created", () => {
    addBrowser("first", { location: "grid", lastActiveAt: 1_000 });
    addBrowser("second", { location: "grid", lastActiveAt: 3_000 });
    addBrowser("third", { location: "grid", lastActiveAt: 2_000 });
    expect(navigatedPane()).toBe("second");
    expect(activateTerminal).toHaveBeenCalledWith("second");
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("reuses a docked pane", () => {
    addBrowser("gridded", { location: "grid", lastActiveAt: 1_000 });
    addBrowser("docked", { location: "dock", lastActiveAt: 2_000 });
    expect(navigatedPane()).toBe("docked");
  });

  it.each(["trash", "background", "dialog", "overlay"])(
    "skips a %s pane even when it was used last",
    (location) => {
      addBrowser("hidden", { location, lastActiveAt: 9_000 });
      addBrowser("visible", { location: "grid", lastActiveAt: 1_000 });
      expect(navigatedPane()).toBe("visible");
      expect(activateTerminal).toHaveBeenCalledWith("visible");
    }
  );

  it("opens a new pane when the only browsers in the worktree are out of sight", () => {
    addBrowser("trashed", { location: "trash", lastActiveAt: 3_000 });
    addBrowser("parked", { location: "background", lastActiveAt: 2_000 });
    addBrowser("modal", { location: "dialog", lastActiveAt: 1_000 });
    expect(navigatedPane()).toBeUndefined();
    expect(activateTerminal).not.toHaveBeenCalled();
    expect(addPanel).toHaveBeenCalledWith({
      kind: "browser",
      browserUrl: "http://localhost:5173/",
      worktreeId: "w1",
      cwd: "/repo",
    });
  });

  it("ignores a more recent pane in another worktree", () => {
    addBrowser("mine", { location: "grid", lastActiveAt: 1_000 });
    addBrowser("theirs", { location: "grid", worktreeId: "w2", lastActiveAt: 5_000 });
    expect(navigatedPane()).toBe("mine");
  });

  it("prefers a pane that has been used over one that never has", () => {
    addBrowser("unused", { location: "grid" });
    addBrowser("used", { location: "grid", lastActiveAt: 1_000 });
    expect(navigatedPane()).toBe("used");
  });

  it("keeps panel order between panes used at the same moment or never", () => {
    addBrowser("a", { location: "grid", lastActiveAt: 1_000 });
    addBrowser("b", { location: "grid", lastActiveAt: 1_000 });
    expect(navigatedPane()).toBe("a");

    setBrowserUrl.mockClear();
    panelState.panelIds = ["t1"];
    addBrowser("c");
    addBrowser("d");
    expect(navigatedPane()).toBe("c");
  });

  it("treats a negative stamp as never used", () => {
    addBrowser("negative", { location: "grid", lastActiveAt: -5 });
    addBrowser("unstamped", { location: "grid" });
    expect(navigatedPane()).toBe("negative");
  });

  it("brings a pane behind another tab forward before activating it", () => {
    addBrowser("tabbed", { location: "grid", lastActiveAt: 2_000 });
    getPanelGroup.mockImplementation((id) =>
      id === "tabbed" ? { id: "g1", panelIds: ["other", "tabbed"] } : undefined
    );
    expect(navigatedPane()).toBe("tabbed");
    expect(setActiveTab).toHaveBeenCalledExactlyOnceWith("g1", "tabbed");
    expect(setActiveTab.mock.invocationCallOrder[0]).toBeLessThan(
      activateTerminal.mock.invocationCallOrder[0]!
    );
  });

  it("leaves tabs alone for a pane outside a group", () => {
    addBrowser("loose", { location: "grid", lastActiveAt: 1_000 });
    expect(navigatedPane()).toBe("loose");
    expect(getPanelGroup).toHaveBeenCalledWith("loose");
    expect(setActiveTab).not.toHaveBeenCalled();
  });

  it("reuses a legacy pane saved before panels had a location", () => {
    addBrowser("trashed", { location: "trash", lastActiveAt: 2_000 });
    addBrowser("legacy", { lastActiveAt: 1_000 });
    expect(navigatedPane()).toBe("legacy");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -5])(
    "does not let a %s stamp outrank a real one",
    (stamp) => {
      addBrowser("corrupt", { location: "grid", lastActiveAt: stamp });
      addBrowser("real", { location: "grid", lastActiveAt: 1_000 });
      expect(navigatedPane()).toBe("real");
    }
  );

  it("skips an id the registry no longer holds", () => {
    panelState.panelIds = ["t1", "vanished"];
    addBrowser("live", { location: "grid", lastActiveAt: 1_000 });
    expect(navigatedPane()).toBe("live");
  });

  it("navigates and activates the pane it picked", () => {
    addBrowser("stale", { location: "grid", lastActiveAt: 1_000 });
    addBrowser("recent", { location: "grid", lastActiveAt: 2_000 });
    new TerminalLinkHandler().openLink("http://localhost:5173/", "t1", cmdClick);
    expect(setBrowserUrl).toHaveBeenCalledExactlyOnceWith("recent", "http://localhost:5173/");
    expect(activateTerminal).toHaveBeenCalledExactlyOnceWith("recent");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "browser.navigate",
      { url: "http://localhost:5173/", terminalId: "recent" },
      { source: "user" }
    );
  });
});

describe("plain click on a host's localhost link", () => {
  it("opens the forwarded local address in the system browser", async () => {
    bindView("studio-01");
    new TerminalLinkHandler().openLink("http://localhost:5173/", "t1");
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "http://localhost:15173/" },
      { source: "user" }
    );
    expect(addPanel).not.toHaveBeenCalled();
  });
});

describe("a forward that fails", () => {
  it("tells the user why and opens nothing", async () => {
    bindView("studio-01");
    forward.mockRejectedValueOnce(new Error("host disconnected"));
    new TerminalLinkHandler().openLink("http://localhost:5173/", "t1");
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0]![0]).toMatchObject({
      type: "error",
      title: "Couldn't open link",
    });
    expect(notify.mock.calls[0]![0].message).toContain("Port 5173 on the host");
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("a URL a plugin claims (#13798)", () => {
  it("goes to the plugin instead of the browser", () => {
    activatePluginUrlLink.mockReturnValue(true);
    new TerminalLinkHandler().openLink("https://records.example.com/1", "t1", cmdClick);
    expect(activatePluginUrlLink).toHaveBeenCalledWith("https://records.example.com/1", "t1");
    expect(dispatch).not.toHaveBeenCalled();
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("still opens in the external browser when asked to, without asking the plugin", () => {
    activatePluginUrlLink.mockReturnValue(true);
    new TerminalLinkHandler().openLink("https://records.example.com/1", "t1", cmdClick, {
      external: true,
    });
    expect(activatePluginUrlLink).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://records.example.com/1" },
      { source: "user" }
    );
  });

  it("opens a localhost link externally rather than in a panel when asked for the browser", () => {
    new TerminalLinkHandler().openLink("http://localhost:5173/", "t1", cmdClick, {
      external: true,
    });
    expect(addPanel).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "http://localhost:5173/" },
      { source: "user" }
    );
  });
});

describe("a link from a terminal on a host other than the view's (#15332)", () => {
  it("means that host's localhost, forwarded here, in a view on this machine", async () => {
    new TerminalLinkHandler().openLink("http://localhost:5173/", null, undefined, {
      hostId: "studio-01",
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ hostId: "studio-01" }));
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "http://localhost:15173/" },
      { source: "user" }
    );
  });

  it("means this machine's localhost for a local run, in a view bound to a host", () => {
    bindView("studio-01");
    new TerminalLinkHandler().openLink("http://localhost:5173/", null, undefined, {
      hostId: "local",
    });
    expect(forward).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "http://localhost:5173/" },
      { source: "user" }
    );
  });

  it("opens a modifier-clicked localhost link externally, with no pane of this view's to reuse", async () => {
    new TerminalLinkHandler().openLink("http://localhost:5173/", null, cmdClick, {
      hostId: "studio-01",
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(addPanel).not.toHaveBeenCalled();
    expect(setBrowserUrl).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "http://localhost:15173/" },
      { source: "user" }
    );
  });

  it("hands nothing to a plugin, which has no subject for it here", async () => {
    activatePluginUrlLink.mockReturnValue(true);
    new TerminalLinkHandler().openLink("https://records.example.com/1", null, undefined, {
      hostId: "studio-01",
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(activatePluginUrlLink).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://records.example.com/1" },
      { source: "user" }
    );
  });
});
