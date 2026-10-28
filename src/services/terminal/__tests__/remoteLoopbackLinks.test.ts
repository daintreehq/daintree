// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openExternal = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const dispatch = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));

vi.mock("@/clients", () => ({ systemClient: { openExternal } }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById: {}, panelIds: [] }) },
}));

import { ClientAppError } from "@/utils/clientAppError";
import {
  callbackPortOf,
  HostPortInUseError,
  hostForwardFailure,
  needsHostForward,
  parseLoopbackLink,
  releaseBrowserPanelForwards,
  resolveBrowserUrlForView,
  resolveExternalPageForView,
  resolveTerminalLinkForView,
} from "../remoteLoopbackLinks";
import { TerminalLinkHandler } from "../TerminalLinkHandler";

const forward = vi.fn();
const release = vi.fn(() => Promise.resolve());
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
  release.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { portForwards: { forward, release } },
  });
});

afterEach(() => bindView(null));

describe("browser panel URLs", () => {
  it("leaves every URL alone in a view on this machine", async () => {
    bindView(null);
    expect(needsHostForward("http://localhost:3000/")).toBe(false);
    expect(await resolveBrowserUrlForView("http://localhost:3000/", "panel-1")).toBe(
      "http://localhost:3000/"
    );
    expect(forward).not.toHaveBeenCalled();
  });

  it("holds a host's localhost port for the panel, at the same port, keeping the address", async () => {
    bindView("studio-01");
    forward.mockImplementationOnce(async ({ hostId, remotePort, origin }) => ({
      forwardId: "f1",
      hostId,
      remotePort,
      localPort: remotePort,
      origin,
      label: null,
      createdAt: 1,
    }));
    expect(needsHostForward("localhost:3000")).toBe(true);
    expect(await resolveBrowserUrlForView("http://localhost:3000/app?x=1", "panel-1")).toBe(
      "http://localhost:3000/app?x=1"
    );
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "studio-01",
        remotePort: 3000,
        origin: "browser-panel",
        panelId: "panel-1",
        samePort: true,
      })
    );
  });

  it("lets the panel's forwards go when it closes, in a host's view only", () => {
    bindView("studio-01");
    releaseBrowserPanelForwards("panel-1");
    expect(release).toHaveBeenCalledWith({ panelId: "panel-1" });

    release.mockClear();
    bindView(null);
    releaseBrowserPanelForwards("panel-1");
    expect(release).not.toHaveBeenCalled();
  });

  it("refuses when the port is taken here, rather than show the page at another address", async () => {
    bindView("studio-01");
    // The default mock lands on another local port, as a busy one would.
    await expect(resolveBrowserUrlForView("http://localhost:3000/", "panel-1")).rejects.toThrow(
      "Port 3000 is in use on this machine"
    );
  });

  it("loads an internet page in a host's view as it is", async () => {
    bindView("studio-01");
    expect(needsHostForward("https://github.com/")).toBe(false);
    expect(await resolveBrowserUrlForView("https://github.com/", "panel-1")).toBe(
      "https://github.com/"
    );
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses rather than fall back to this machine's own localhost", async () => {
    bindView("studio-01");
    forward.mockRejectedValueOnce(new Error("host gone"));
    await expect(resolveBrowserUrlForView("http://localhost:3000/", "panel-1")).rejects.toThrow(
      "host gone"
    );
  });
});

describe("system browser pages", () => {
  it("forwards a host's page for as long as it is in use, at the same address", async () => {
    bindView("studio-01");
    forward.mockImplementationOnce(async ({ hostId, remotePort, origin }) => ({
      forwardId: "f1",
      hostId,
      remotePort,
      localPort: remotePort,
      origin,
      label: null,
      createdAt: 1,
    }));
    await expect(
      resolveExternalPageForView("http://127.0.0.1:8080", "Worktree endpoint")
    ).resolves.toBe("http://127.0.0.1:8080/");
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        remotePort: 8080,
        origin: "oauth-callback",
        label: "Worktree endpoint",
        samePort: true,
      })
    );
  });

  it("opens every page as it is in a view on this machine", async () => {
    await expect(resolveExternalPageForView("http://127.0.0.1:8080", "x")).resolves.toBe(
      "http://127.0.0.1:8080"
    );
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("hostForwardFailure", () => {
  it("says the port is taken here, in the conflict's own words", () => {
    const error = new HostPortInUseError(8080);
    expect(hostForwardFailure("http://127.0.0.1:8080", error)).toBe(error.message);
  });

  it("passes on main's words for a port another forward holds, naming its host", () => {
    const error = new ClientAppError(
      "PORT_IN_USE",
      "raw",
      "Port 3000 on this machine already forwards studio-01's port 3000, so the host's page can't open here at the same address. Stop that forward in Ports, then try again."
    );
    expect(hostForwardFailure("http://localhost:3000", error)).toBe(error.userMessage);
  });

  it("names the port and gives the host's reason where it gave one", () => {
    const error = new ClientAppError("UNSUPPORTED", "raw", "The host isn't connected.");
    expect(hostForwardFailure("http://localhost:3000", error)).toBe(
      "Port 3000 on the host couldn't be forwarded to this machine. The host isn't connected."
    );
  });

  it("falls back to a plain reason for an error with no message and a URL with no loopback port", () => {
    expect(hostForwardFailure("https://gpu.staging.dev", undefined)).toBe(
      "The host didn't answer."
    );
  });
});

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
      expect.objectContaining({ remotePort: 54545, origin: "oauth-callback", samePort: true })
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
