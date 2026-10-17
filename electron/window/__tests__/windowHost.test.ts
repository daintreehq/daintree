import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetRemoteServicesForTest, registerRemoteService } from "../../remote/runtime.js";
import { getWindowHostId, isWindowOnRemoteHost, routeNewWindowRequest } from "../windowHost.js";

/** Window 2 is on studio-01; webContents 20 is a studio-01 view, 10 a view of this machine. */
function windowHosts() {
  return {
    windowHost: vi.fn((windowId: number) => (windowId === 2 ? "studio-01" : "local")),
    viewHost: vi.fn((webContentsId: number) => (webContentsId === 20 ? "studio-01" : "local")),
    switchWindowToLocal: vi.fn(),
    openHostProjectInNewWindow: vi.fn(async () => ({
      outcome: "switched" as const,
      hostId: "studio-01",
      projectId: "proj-1",
    })),
  };
}

afterEach(() => {
  _resetRemoteServicesForTest();
});

describe("getWindowHostId", () => {
  it("puts every window on this machine when Remote Hosts isn't running", () => {
    expect(getWindowHostId(2)).toBe("local");
    expect(isWindowOnRemoteHost(2)).toBe(false);
  });

  it("names the host a window was switched to", () => {
    registerRemoteService("windowHosts", windowHosts());
    expect(getWindowHostId(2)).toBe("studio-01");
    expect(isWindowOnRemoteHost(2)).toBe(true);
    expect(isWindowOnRemoteHost(1)).toBe(false);
  });
});

describe("routeNewWindowRequest", () => {
  it("opens a path a host view names as that host's project, in a new window there", async () => {
    const hosts = windowHosts();
    registerRemoteService("windowHosts", hosts);
    const openOnThisMachine = vi.fn(async () => {});

    await routeNewWindowRequest(20, 2, "/srv/app", openOnThisMachine);

    expect(hosts.openHostProjectInNewWindow).toHaveBeenCalledExactlyOnceWith(
      "studio-01",
      "/srv/app"
    );
    expect(openOnThisMachine).not.toHaveBeenCalled();
  });

  it("goes by the asking view's host, not where its window has moved since", async () => {
    const hosts = windowHosts();
    registerRemoteService("windowHosts", hosts);
    const openOnThisMachine = vi.fn(async () => {});

    // The studio-01 view asked from window 1, which is back on this machine.
    await routeNewWindowRequest(20, 1, "/srv/app", openOnThisMachine);
    // A view of this machine still cached in window 2, which is on studio-01.
    await routeNewWindowRequest(10, 2, "/work/app", openOnThisMachine);

    expect(hosts.openHostProjectInNewWindow).toHaveBeenCalledExactlyOnceWith(
      "studio-01",
      "/srv/app"
    );
    expect(openOnThisMachine).toHaveBeenCalledExactlyOnceWith("/work/app", 2);
  });

  it("opens a plain New Window from a host view on this machine", async () => {
    const hosts = windowHosts();
    registerRemoteService("windowHosts", hosts);
    const openOnThisMachine = vi.fn(async () => {});

    await routeNewWindowRequest(20, 2, undefined, openOnThisMachine);

    expect(openOnThisMachine).toHaveBeenCalledExactlyOnceWith(undefined, 2);
    expect(hosts.openHostProjectInNewWindow).not.toHaveBeenCalled();
  });

  it("keeps every folder on this machine when Remote Hosts isn't running", async () => {
    const openOnThisMachine = vi.fn(async () => {});

    await routeNewWindowRequest(20, 2, "/work/app", openOnThisMachine);
    await routeNewWindowRequest(10, null, "/work/other", openOnThisMachine);

    expect(openOnThisMachine.mock.calls).toEqual([
      ["/work/app", 2],
      ["/work/other", null],
    ]);
  });

  it("surfaces the host's refusal rather than opening the path on this machine", async () => {
    const hosts = windowHosts();
    hosts.openHostProjectInNewWindow.mockRejectedValueOnce(new Error("not on that host"));
    registerRemoteService("windowHosts", hosts);
    const openOnThisMachine = vi.fn(async () => {});

    await expect(routeNewWindowRequest(20, 2, "/srv/gone", openOnThisMachine)).rejects.toThrow(
      "not on that host"
    );
    expect(openOnThisMachine).not.toHaveBeenCalled();
  });
});
