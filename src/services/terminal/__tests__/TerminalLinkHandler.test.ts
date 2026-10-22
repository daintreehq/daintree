// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));
const notify = vi.hoisted(() => vi.fn());
const addPanel = vi.hoisted(() => vi.fn(() => Promise.resolve("new")));
const setBrowserUrl = vi.hoisted(() => vi.fn());
const activateTerminal = vi.hoisted(() => vi.fn());
const panelState = vi.hoisted(() => ({
  panelsById: {} as Record<string, unknown>,
  panelIds: [] as string[],
}));

vi.mock("@/clients", () => ({ systemClient: { openExternal: vi.fn() } }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/lib/platform", () => ({ isMac: () => true }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ ...panelState, addPanel, setBrowserUrl, activateTerminal }),
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
  notify.mockClear();
  addPanel.mockClear();
  setBrowserUrl.mockClear();
  activateTerminal.mockClear();
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
