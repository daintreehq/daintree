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

vi.mock("@/clients", () => ({ systemClient: { openExternal } }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => selection },
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

import { openLinkUrl, opensInPanel } from "../openLinkUrl";

function browser(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "browser", location: "grid", worktreeId: "w1", ...extra };
}

function preview(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "dev-preview",
    location: "grid",
    worktreeId: "w1",
    devServerStatus: "running",
    devServerUrl: "http://localhost:5173/",
    ...extra,
  };
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
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://ci.example.com/"));
  });

  it("refuses an address that isn't http(s), with a notice", async () => {
    await openLinkUrl("javascript:alert(1)");
    expect(dispatch).not.toHaveBeenCalled();
    expect(addPanel).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't open link" })
    );
  });
});

describe("openLinkUrl for a loopback address", () => {
  it("prefers the running dev preview serving that origin in the active worktree", async () => {
    withPanels(browser("b1", { lastActiveAt: 50 }), preview("p1"));
    getPanelGroup.mockReturnValue({ id: "g1", panelIds: ["p1", "x"] });
    await openLinkUrl("http://localhost:5173/settings");
    expect(activateTerminal).toHaveBeenCalledWith("p1");
    expect(setActiveTab).toHaveBeenCalledWith("g1", "p1");
    // The preview maps the address onto its own proxy; its stored URL is its own.
    expect(setBrowserUrl).not.toHaveBeenCalled();
    expect(navigatedTo()).toEqual([{ url: "http://localhost:5173/settings", terminalId: "p1" }]);
    expect(dispatch).not.toHaveBeenCalledWith("system.openExternal", expect.anything(), expect.anything());
  });

  it("passes over a preview that isn't running, serves another port, or belongs elsewhere", async () => {
    withPanels(
      preview("stopped", { devServerStatus: "stopped" }),
      preview("other-port", { devServerUrl: "http://localhost:3000/" }),
      preview("other-tree", { worktreeId: "w2" }),
      preview("trashed", { location: "trash" }),
      browser("b1")
    );
    await openLinkUrl("http://localhost:5173/");
    expect(activateTerminal).toHaveBeenCalledWith("b1");
    expect(setBrowserUrl).toHaveBeenCalledWith("b1", "http://localhost:5173/");
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
