// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openExternal = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const dispatch = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));

vi.mock("@/clients", () => ({ systemClient: { openExternal } }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById: {}, panelIds: [] }) },
}));

import {
  callbackPortOf,
  parseLoopbackLink,
  resolveTerminalLinkForView,
} from "../remoteLoopbackLinks";
import { TerminalLinkHandler } from "../TerminalLinkHandler";

const forward = vi.fn();
// Long enough for a rejected forward to settle, so a late open would have happened.
const SETTLE_MS = 10;

function bindView(hostId: string | null): void {
  if (hostId === null) delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  else window.__DAINTREE_HOST_ID__ = { id: hostId };
}

beforeEach(() => {
  forward.mockReset();
  forward.mockImplementation(async ({ hostId, remotePort, origin }) => ({
    forwardId: "f1",
    hostId,
    remotePort,
    localPort: remotePort + 10_000,
    origin,
    label: null,
    createdAt: 1,
  }));
  openExternal.mockClear();
  dispatch.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { portForwards: { forward } },
  });
});

afterEach(() => bindView(null));

describe("link parsing", () => {
  it("finds the port a loopback link names", () => {
    expect(parseLoopbackLink("http://localhost:5173/app")?.port).toBe(5173);
    expect(parseLoopbackLink("localhost:3000")?.port).toBe(3000);
    expect(parseLoopbackLink("http://127.0.0.1/")?.port).toBe(80);
    expect(parseLoopbackLink("https://github.com/")).toBeNull();
  });

  it("finds a loopback redirect target in a sign-in URL", () => {
    expect(
      callbackPortOf(
        "https://auth.example.com/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback"
      )
    ).toBe(54545);
    expect(
      callbackPortOf(
        "https://auth.example.com/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb"
      )
    ).toBeNull();
    expect(callbackPortOf("https://example.com/?next=http%3A%2F%2Flocalhost%3A1")).toBeNull();
  });
});

describe("resolveTerminalLinkForView", () => {
  it("leaves every link alone in a local view", async () => {
    await expect(resolveTerminalLinkForView("http://localhost:5173/")).resolves.toBe(
      "http://localhost:5173/"
    );
    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards a remote terminal's localhost link for the flow and rewrites it to the local end", async () => {
    bindView("studio-01");
    await expect(resolveTerminalLinkForView("http://localhost:8085/auth?x=1")).resolves.toBe(
      "http://localhost:18085/auth?x=1"
    );
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "studio-01", remotePort: 8085, origin: "oauth-callback" })
    );
  });

  it("forwards a sign-in's loopback callback port and opens the provider page unchanged", async () => {
    bindView("studio-01");
    const url =
      "https://auth.example.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A54545%2Fcb";
    forward.mockImplementationOnce(async ({ hostId, remotePort, origin }) => ({
      forwardId: "f2",
      hostId,
      remotePort,
      localPort: remotePort,
      origin,
      label: null,
      createdAt: 1,
    }));
    await expect(resolveTerminalLinkForView(url)).resolves.toBe(url);
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({ remotePort: 54545, origin: "oauth-callback" })
    );
  });

  it("refuses a sign-in whose callback port is taken here, since the provider would land on this machine", async () => {
    bindView("studio-01");
    const url =
      "https://auth.example.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A54545%2Fcb";
    await expect(resolveTerminalLinkForView(url)).rejects.toThrow(/in use on this machine/);
  });

  it("fails rather than open this machine's localhost when the forward can't be made", async () => {
    bindView("studio-01");
    forward.mockRejectedValueOnce(new Error("host disconnected"));
    await expect(resolveTerminalLinkForView("http://localhost:8085/")).rejects.toThrow(
      "host disconnected"
    );
  });
});

describe("TerminalLinkHandler in a remote view", () => {
  it("opens the local browser at the forwarded URL", async () => {
    bindView("studio-01");
    new TerminalLinkHandler().openLink("http://localhost:8085/login", "t1");
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "http://localhost:18085/login" },
      { source: "user" }
    );
  });

  it("opens nothing when the forward fails", async () => {
    bindView("studio-01");
    forward.mockRejectedValueOnce(new Error("nope"));
    new TerminalLinkHandler().openLink("http://localhost:8085/login", "t1");
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("opens links unchanged in a local view without forwarding", async () => {
    new TerminalLinkHandler().openLink("http://localhost:8085/login", "t1");
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "http://localhost:8085/login" },
      { source: "user" }
    );
    expect(forward).not.toHaveBeenCalled();
  });
});
