// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() =>
  vi.fn<(id: string, args: unknown, opts: unknown) => Promise<{ ok: boolean }>>(() =>
    Promise.resolve({ ok: true })
  )
);
const openExternal = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const notify = vi.hoisted(() => vi.fn());
const addPanel = vi.hoisted(() => vi.fn(() => Promise.resolve("new")));
const setBrowserUrl = vi.hoisted(() => vi.fn<(id: string, url: string) => void>());
const activateTerminal = vi.hoisted(() => vi.fn<(id: string) => void>());
const setActiveTab = vi.hoisted(() => vi.fn<(groupId: string, panelId: string) => void>());
const getPanelGroup = vi.hoisted(() =>
  vi.fn<(panelId: string) => { id: string; panelIds: string[] } | undefined>()
);
const panelState = vi.hoisted(() => ({
  panelsById: {} as Record<string, unknown>,
  panelIds: [] as string[],
}));
const selection = vi.hoisted(() => ({ activeWorktreeId: "w1" as string | null }));
const devServers = vi.hoisted(() => ({
  sessions: [] as Array<{ panelId: string; status: string; url: string | null }>,
  getAllSessions: vi.fn<() => Promise<unknown[]>>(),
}));
const remote = vi.hoisted(() => ({
  hostId: null as string | null,
  resolve: vi.fn<(url: string, hostId: string | null) => Promise<string>>((url) =>
    Promise.resolve(url)
  ),
}));

vi.mock("@/clients", () => ({ systemClient: { openExternal } }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => selection },
}));
vi.mock("@/services/terminal/remoteLoopbackLinks", async (importOriginal) => ({
  parseLoopbackLink: (
    await importOriginal<typeof import("@/services/terminal/remoteLoopbackLinks")>()
  ).parseLoopbackLink,
  remoteHostOfView: () => remote.hostId,
  resolveTerminalLinkForHost: (url: string, hostId: string | null) => remote.resolve(url, hostId),
  hostForwardFailure: () => "Port 8765 is in use on this machine",
}));
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

import { openLinkUrl, openLinkUrlExternally, opensInPanel } from "../openLinkUrl";

function browser(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "browser", location: "grid", worktreeId: "w1", ...extra };
}

function preview(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "dev-preview", location: "grid", worktreeId: "w1", ...extra };
}

function serving(panelId: string, status = "running", url = "http://localhost:5173"): void {
  devServers.sessions.push({ panelId, status, url });
}

function withPanels(...panels: Array<{ id: string }>): void {
  panelState.panelsById = Object.fromEntries(panels.map((p) => [p.id, p]));
  panelState.panelIds = panels.map((p) => p.id);
}

function navigatedTo(): Array<unknown> {
  return dispatch.mock.calls.filter(([id]) => id === "browser.navigate").map(([, args]) => args);
}

beforeEach(() => {
  dispatch.mockReset().mockResolvedValue({ ok: true });
  openExternal.mockClear();
  notify.mockClear();
  addPanel.mockClear();
  setBrowserUrl.mockClear();
  activateTerminal.mockClear();
  setActiveTab.mockClear();
  getPanelGroup.mockReset().mockReturnValue(undefined);
  selection.activeWorktreeId = "w1";
  devServers.sessions = [];
  devServers.getAllSessions
    .mockReset()
    .mockImplementation(() => Promise.resolve(devServers.sessions));
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { devPreview: { getAllSessions: devServers.getAllSessions } },
  });
  remote.hostId = null;
  remote.resolve.mockReset().mockImplementation((url) => Promise.resolve(url));
  withPanels();
});

describe("opensInPanel", () => {
  it("is true for loopback http(s) addresses only", () => {
    expect(opensInPanel("http://localhost:3000/app")).toBe(true);
    expect(opensInPanel("http://127.0.0.1:8080")).toBe(true);
    expect(opensInPanel("http://0.0.0.0:4000")).toBe(true);
    expect(opensInPanel("https://staging.example.com")).toBe(false);
    expect(opensInPanel("http://192.168.1.4:3000")).toBe(false);
    expect(opensInPanel("ftp://localhost/file")).toBe(false);
  });
});

describe("openLinkUrl for an outside address", () => {
  it("hands it to the system browser and opens no panel", async () => {
    withPanels(browser("b1"));
    await openLinkUrl("https://staging.example.com/dashboard");
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://staging.example.com/dashboard" },
      { source: "user" }
    );
    expect(addPanel).not.toHaveBeenCalled();
    expect(activateTerminal).not.toHaveBeenCalled();
    expect(navigatedTo()).toEqual([]);
  });

  it("falls back to IPC when the action is refused", async () => {
    dispatch.mockResolvedValue({ ok: false });
    await openLinkUrl("https://ci.example.com");
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://ci.example.com"));
  });

  it("refuses an address that isn't http(s), with a notice", async () => {
    await openLinkUrl("javascript:alert(1)");
    expect(dispatch).not.toHaveBeenCalled();
    expect(addPanel).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't open link" })
    );
  });

  it("hands the address over exactly as saved", async () => {
    const saved = "https://user:token@files.example.com/download/0.0.0.0?sig=AbC#part";
    await openLinkUrl(saved);
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: saved },
      { source: "user" }
    );
  });

  it.each(["https:status.example.com/x", "HTTPS://Status.Example.com/x"])(
    "keeps an explicit web scheme as saved (%s)",
    async (saved) => {
      await openLinkUrl(saved);
      expect(dispatch).toHaveBeenCalledWith(
        "system.openExternal",
        { url: saved },
        { source: "user" }
      );
    }
  );

  it.each(["mailto:team@example.com", "file:///etc/hosts", "data:text/html,hi"])(
    "refuses a non-web scheme (%s)",
    async (saved) => {
      await openLinkUrl(saved);
      expect(dispatch).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(1);
    }
  );

  it("reads a bare host with a port as https", async () => {
    await openLinkUrl("grafana.example.com:3000/d/abc");
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://grafana.example.com:3000/d/abc" },
      { source: "user" }
    );
  });

  it("reads a bare host as https", async () => {
    await openLinkUrl("status.example.com/incidents");
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://status.example.com/incidents" },
      { source: "user" }
    );
  });

  it("in a view bound to a host, opens what the host's forwarding made of it", async () => {
    remote.hostId = "studio-01";
    const saved = "https://auth.example.com/authorize?redirect_uri=http://localhost:8765/cb";
    remote.resolve.mockResolvedValue(`${saved}&forwarded=1`);
    await openLinkUrl(saved);
    expect(remote.resolve).toHaveBeenCalledWith(saved, "studio-01");
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: `${saved}&forwarded=1` },
      { source: "user" }
    );
  });

  it("in a view bound to a host, says why when the forward fails and opens nothing", async () => {
    remote.hostId = "studio-01";
    remote.resolve.mockRejectedValue(new Error("Port 8765 is in use on this machine"));
    await openLinkUrl("https://auth.example.com/authorize?redirect_uri=http://localhost:8765/cb");
    expect(dispatch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't open link",
        message: "Port 8765 is in use on this machine",
      })
    );
  });

  it("never forwards in a local view", async () => {
    await openLinkUrl("https://ci.example.com");
    expect(remote.resolve).not.toHaveBeenCalled();
  });
});

function openedExternally(): Array<unknown> {
  return dispatch.mock.calls
    .filter(([id]) => id === "system.openExternal")
    .map(([, args]) => (args as { url: string }).url);
}

describe("openLinkUrlExternally", () => {
  it("opens a local address in the system browser exactly as saved, never in a panel", async () => {
    withPanels(preview("p1"), browser("b1"));
    serving("p1", "running", "http://localhost:3000");
    const saved = "http://localhost:3000/admin/0.0.0.0?tab=users#top";
    await openLinkUrlExternally(saved);
    expect(openedExternally()).toEqual([saved]);
    expect(devServers.getAllSessions).not.toHaveBeenCalled();
    expect(addPanel).not.toHaveBeenCalled();
    expect(activateTerminal).not.toHaveBeenCalled();
    expect(navigatedTo()).toEqual([]);
  });

  it.each([
    ["localhost:3000/admin", "http://localhost:3000/admin"],
    ["127.0.0.1:8080/x?y=1", "http://127.0.0.1:8080/x?y=1"],
    ["[::1]:5173", "http://[::1]:5173"],
  ])("reads a bare loopback address (%s) as http, as a panel would", async (saved, opened) => {
    await openLinkUrlExternally(saved);
    expect(openedExternally()).toEqual([opened]);
  });

  it.each([
    ["status.example.com/incidents", "https://status.example.com/incidents"],
    [
      "https://user:token@files.example.com/download/0.0.0.0?sig=AbC#part",
      "https://user:token@files.example.com/download/0.0.0.0?sig=AbC#part",
    ],
  ])("opens an outside address (%s) as the row's own open does", async (saved, opened) => {
    await openLinkUrlExternally(saved);
    expect(openedExternally()).toEqual([opened]);
  });

  it.each(["javascript:alert(1)", "mailto:team@example.com", "ftp://localhost/file"])(
    "refuses an address that isn't http(s) (%s), with a notice",
    async (saved) => {
      await openLinkUrlExternally(saved);
      expect(dispatch).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Couldn't open link" })
      );
    }
  );

  it("in a view bound to a host, forwards a loopback address's port and keeps the rest of it", async () => {
    remote.hostId = "studio-01";
    remote.resolve.mockImplementation((url) =>
      Promise.resolve(url === "http://localhost:3000" ? "http://localhost:49152/" : url)
    );
    await openLinkUrlExternally("http://localhost:3000/docs/0.0.0.0?bind=0.0.0.0#setup");
    expect(remote.resolve).toHaveBeenCalledTimes(1);
    expect(remote.resolve).toHaveBeenCalledWith("http://localhost:3000", "studio-01");
    expect(openedExternally()).toEqual(["http://localhost:49152/docs/0.0.0.0?bind=0.0.0.0#setup"]);
  });

  it("in a view bound to a host, forwards a bare loopback address too", async () => {
    remote.hostId = "studio-01";
    remote.resolve.mockResolvedValue("http://localhost:49153/");
    await openLinkUrlExternally("0.0.0.0:8000/admin");
    expect(remote.resolve).toHaveBeenCalledWith("http://localhost:8000", "studio-01");
    expect(openedExternally()).toEqual(["http://localhost:49153/admin"]);
  });

  it("in a view bound to a host, hands an outside address to the forwarding whole", async () => {
    remote.hostId = "studio-01";
    const saved = "https://auth.example.com/authorize?redirect_uri=http://localhost:8765/cb";
    await openLinkUrlExternally(saved);
    expect(remote.resolve).toHaveBeenCalledWith(saved, "studio-01");
    expect(openedExternally()).toEqual([saved]);
  });

  it("in a view bound to a host, says why when the forward fails and opens nothing", async () => {
    remote.hostId = "studio-01";
    remote.resolve.mockRejectedValue(new Error("refused"));
    await openLinkUrlExternally("http://localhost:3000/admin");
    expect(dispatch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't open link",
        message: "Port 8765 is in use on this machine",
      })
    );
  });

  it("never forwards in a local view", async () => {
    await openLinkUrlExternally("http://localhost:3000/admin");
    expect(remote.resolve).not.toHaveBeenCalled();
  });
});

describe("openLinkUrl for a loopback address", () => {
  it("prefers the running dev preview serving that origin in the active worktree", async () => {
    withPanels(browser("b1", { lastActiveAt: 50 }), preview("p1"));
    serving("p1");
    getPanelGroup.mockReturnValue({ id: "g1", panelIds: ["p1", "x"] });
    await openLinkUrl("http://localhost:5173/settings");
    expect(activateTerminal).toHaveBeenCalledWith("p1");
    expect(setActiveTab).toHaveBeenCalledWith("g1", "p1");
    // The preview maps the address onto its own proxy; its stored URL is its own.
    expect(setBrowserUrl).not.toHaveBeenCalled();
    expect(navigatedTo()).toEqual([{ url: "http://localhost:5173/settings", terminalId: "p1" }]);
    expect(dispatch).not.toHaveBeenCalledWith(
      "system.openExternal",
      expect.anything(),
      expect.anything()
    );
  });

  it("finds the right one of several previews in the worktree", async () => {
    withPanels(
      preview("api", { lastActiveAt: 90 }),
      preview("web", { lastActiveAt: 10 }),
      preview("web-stopped", { lastActiveAt: 99 }),
      browser("b1")
    );
    serving("api", "running", "http://localhost:3000");
    serving("web-stopped", "stopped", "http://localhost:5173");
    serving("web", "running", "http://localhost:5173");
    await openLinkUrl("http://localhost:5173/");
    expect(activateTerminal).toHaveBeenCalledWith("web");
  });

  it.each([
    ["isn't running", () => serving("p1", "starting")],
    ["serves another port", () => serving("p1", "running", "http://localhost:3000")],
    ["has no session", () => {}],
  ])("passes over a dev preview whose server %s", async (_label, arrange) => {
    withPanels(preview("p1"), browser("b1"));
    arrange();
    await openLinkUrl("http://localhost:5173/");
    expect(activateTerminal).toHaveBeenCalledWith("b1");
    expect(setBrowserUrl).toHaveBeenCalledWith("b1", "http://localhost:5173/");
  });

  it.each([
    ["sits in another worktree", { worktreeId: "w2" }],
    ["can't be brought on screen", { location: "trash" }],
  ])("passes over a serving preview that %s", async (_label, extra) => {
    withPanels(preview("p1", extra), browser("b1"));
    serving("p1");
    await openLinkUrl("http://localhost:5173/");
    expect(activateTerminal).toHaveBeenCalledWith("b1");
  });

  it("passes over a preview closed while main was answering", async () => {
    withPanels(preview("p1"), browser("b1"));
    serving("p1");
    let answer: (sessions: unknown[]) => void = () => {};
    devServers.getAllSessions.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const opening = openLinkUrl("http://localhost:5173/");
    // Closing a pane trashes it; its record stays.
    withPanels(preview("p1", { location: "trash" }), browser("b1"));
    answer(devServers.sessions);
    await opening;
    expect(activateTerminal).toHaveBeenCalledWith("b1");
    expect(activateTerminal).not.toHaveBeenCalledWith("p1");
  });

  it("reads a loopback address saved without slashes as the address it names", async () => {
    withPanels(browser("b1"));
    await openLinkUrl("http:localhost:5173/settings");
    expect(setBrowserUrl).toHaveBeenCalledWith("b1", "http://localhost:5173/settings");
    expect(dispatch).not.toHaveBeenCalledWith(
      "system.openExternal",
      expect.anything(),
      expect.anything()
    );
  });

  it("falls back to a browser pane when main can't list the dev servers", async () => {
    withPanels(preview("p1"), browser("b1"));
    devServers.getAllSessions.mockRejectedValue(new Error("host gone"));
    await openLinkUrl("http://localhost:5173/");
    expect(activateTerminal).toHaveBeenCalledWith("b1");
  });

  it("reuses the most recently used browser pane of the active worktree", async () => {
    withPanels(
      browser("old", { lastActiveAt: 10 }),
      browser("recent", { lastActiveAt: 90 }),
      browser("elsewhere", { worktreeId: "w2", lastActiveAt: 500 })
    );
    await openLinkUrl("http://localhost:3000/health");
    expect(setBrowserUrl).toHaveBeenCalledWith("recent", "http://localhost:3000/health");
    expect(activateTerminal).toHaveBeenCalledWith("recent");
    expect(navigatedTo()).toEqual([{ url: "http://localhost:3000/health", terminalId: "recent" }]);
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("opens a browser pane in the active worktree when none can be reused", async () => {
    withPanels(browser("elsewhere", { worktreeId: "w2" }));
    await openLinkUrl("http://127.0.0.1:8080/");
    expect(addPanel).toHaveBeenCalledWith({
      kind: "browser",
      browserUrl: "http://127.0.0.1:8080/",
      worktreeId: "w1",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("opens an unassigned pane with no active worktree, never the system browser", async () => {
    selection.activeWorktreeId = null;
    await openLinkUrl("http://localhost:4000");
    expect(addPanel).toHaveBeenCalledWith({
      kind: "browser",
      browserUrl: "http://localhost:4000/",
      worktreeId: undefined,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
