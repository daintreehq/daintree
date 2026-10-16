import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanopyHostEvent } from "../../../../shared/types/ipc/canopyHost.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { EventMessage } from "../../link/messages.js";
import {
  CanopyHostsClient,
  RELEASE_RETRIES,
  RELEASE_RETRY_MS,
  type CanopyHostConnection,
} from "../client.js";
import { AppError } from "../../../utils/errorTypes.js";
import { CANOPY_VIEWER_ENDPOINT_PREFIX, CanopyLinkMethod } from "../linkMethods.js";
import { CanopyViewers } from "../viewer.js";

const VIEW = 7;

function setup(options: { hostForView?: (id: number) => string | null } = {}) {
  const hosts = new Set(["studio", "attic"]);
  const connections = new Map<string, CanopyHostConnection & { calls: unknown[][] }>();
  const releaseFailures: Error[] = [];
  const connection = (hostId: string) => {
    const calls: unknown[][] = [];
    const conn = {
      calls,
      callHost: vi.fn(async (method: string, payload: unknown) => {
        calls.push([method, payload]);
        if (method === CanopyLinkMethod.RELEASE) {
          const failure = releaseFailures.shift();
          if (failure) throw failure;
        }
        return method === CanopyLinkMethod.INVOKE ? wrapSuccess({ from: hostId }) : null;
      }),
    };
    connections.set(hostId, conn);
    return conn;
  };
  connection("studio");
  connection("attic");
  const useChecks: Array<(hostId: string) => boolean> = [];
  const sessionListeners: Array<
    (
      hostId: string,
      session: {
        registerCallHandler: (m: string, s: unknown, h: (p: never) => unknown) => () => void;
      }
    ) => void
  > = [];
  const callHandlers = new Map<string, (payload: never) => unknown>();
  const fakeSession = {
    registerCallHandler: (method: string, _schema: unknown, handler: (p: never) => unknown) => {
      callHandlers.set(method, handler);
      return () => {};
    },
  };
  const viewerListeners: Array<(hostId: string, event: EventMessage) => void> = [];
  const registryListeners: Array<() => void> = [];
  const touched: string[] = [];
  const connect = vi.fn();
  const sent: Array<{ webContentsId: number; event: CanopyHostEvent }> = [];
  let viewerCount = 0;
  const client = new CanopyHostsClient({
    manager: {
      get: (hostId) => connections.get(hostId),
      connect,
      touch: (hostId) => touched.push(hostId),
      addUseCheck: (check) => {
        useChecks.push(check);
        return () => {};
      },
      onSessionOpened: (listener) => {
        sessionListeners.push(listener as (typeof sessionListeners)[number]);
        return () => {};
      },
      onViewerEvent: (listener) => {
        viewerListeners.push(listener);
        return () => {};
      },
    },
    registry: {
      get: (hostId) => (hosts.has(hostId) ? { id: hostId } : null),
      onChange: (listener) => {
        registryListeners.push(listener);
        return () => {};
      },
    },
    hostForView: options.hostForView ?? (() => null),
    local: new CanopyViewers({
      source: { observeCanopy: () => () => {}, observeFleet: () => null },
      invoke: async () => wrapSuccess(null),
    }),
    localClient: { clientId: "local", clientName: "mbp", platform: "darwin", kind: "local" },
    send: (webContentsId, event) => {
      sent.push({ webContentsId, event });
      return true;
    },
    watchView: () => () => {},
    newViewerId: () => `v${++viewerCount}`,
  });
  client.start();
  return {
    client,
    hosts,
    connections,
    sent,
    touched,
    connect,
    inUse: (hostId: string) => useChecks.some((check) => check(hostId)),
    releaseFailures,
    sessionOpened: (hostId: string) => sessionListeners.forEach((l) => l(hostId, fakeSession)),
    hostSays: (method: string, payload: unknown) => callHandlers.get(method)?.(payload as never),
    viewerEvent: (hostId: string, event: EventMessage) =>
      viewerListeners.forEach((l) => l(hostId, event)),
    registryChanged: () => registryListeners.forEach((l) => l()),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CanopyHostsClient", () => {
  it("names the viewer and the allowed channel to the host, and answers its data", async () => {
    const s = setup();
    await expect(s.client.invoke(VIEW, "studio", "canopy:get-snapshot", [])).resolves.toEqual({
      from: "studio",
    });
    expect(s.connections.get("studio")!.calls).toEqual([
      [CanopyLinkMethod.INVOKE, { viewerId: "v1", channel: "canopy:get-snapshot", args: [] }],
    ]);
    expect(s.touched).toContain("studio");
  });

  it("refuses typing into a run, and any channel outside Canopy's reads and actions", async () => {
    const s = setup();
    for (const channel of ["canopy:terminal-input", "canopy:answer", "terminal:write"]) {
      await expect(s.client.invoke(VIEW, "studio", channel, [])).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
    expect(s.connections.get("studio")!.calls).toEqual([]);
  });

  it("refuses a host that isn't in the host list", async () => {
    const s = setup();
    await expect(s.client.invoke(VIEW, "gone", "canopy:get-snapshot", [])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("dials a host with no link yet, and says it isn't connected", async () => {
    const s = setup();
    s.connections.delete("attic");
    await expect(s.client.invoke(VIEW, "attic", "canopy:get-snapshot", [])).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    expect(s.connect).toHaveBeenCalledWith("attic");
    // The panel still reads it, so the link it asked for is kept and resynced.
    expect(s.inUse("attic")).toBe(true);
  });

  it("delivers a viewer's push only from the host it reads, tagged with that host", async () => {
    const s = setup();
    await s.client.invoke(VIEW, "studio", "canopy:get-snapshot", []);
    const event = (channel: string): EventMessage => ({
      endpointId: CANOPY_VIEWER_ENDPOINT_PREFIX + "v1",
      channel,
      args: [{ sequence: 3 }],
    });
    s.viewerEvent("attic", event("canopy:snapshot-updated"));
    s.viewerEvent("studio", event("terminal:data"));
    s.viewerEvent("studio", event("fleet:snapshot-updated"));
    expect(s.sent).toEqual([
      {
        webContentsId: VIEW,
        event: { kind: "fleet-snapshot", hostId: "studio", snapshot: { sequence: 3 } },
      },
    ]);
  });

  it("tells each reader of a host to read again when its link comes back", async () => {
    const s = setup();
    await s.client.invoke(VIEW, "studio", "canopy:get-snapshot", []);
    await s.client.invoke(VIEW + 1, "attic", "canopy:get-snapshot", []);
    s.sessionOpened("studio");
    expect(s.sent).toEqual([{ webContentsId: VIEW, event: { kind: "resync", hostId: "studio" } }]);
  });

  it("keeps a host in use until its last panel is released, then restarts its idle clock", async () => {
    const s = setup();
    await s.client.invoke(VIEW, "studio", "canopy:get-snapshot", []);
    await s.client.invoke(VIEW + 1, "studio", "canopy:get-snapshot", []);
    s.client.release(VIEW, "studio");
    expect(s.inUse("studio")).toBe(true);
    s.touched.length = 0;
    s.client.release(VIEW + 1, "studio");
    expect(s.inUse("studio")).toBe(false);
    expect(s.touched).toEqual(["studio"]);
    expect(s.connections.get("studio")!.calls.at(-1)).toEqual([
      CanopyLinkMethod.RELEASE,
      { viewerId: "v2" },
    ]);
  });

  it("forgets the panels on a host removed from the list", async () => {
    const s = setup();
    await s.client.invoke(VIEW, "studio", "canopy:get-snapshot", []);
    s.hosts.delete("studio");
    s.registryChanged();
    expect(s.inUse("studio")).toBe(false);
  });

  it("tells only the panel whose push the host lost to read again", async () => {
    const s = setup();
    await s.client.invoke(VIEW, "studio", "canopy:get-snapshot", []);
    await s.client.invoke(VIEW + 1, "studio", "canopy:get-snapshot", []);
    s.sessionOpened("studio");
    s.sent.length = 0;
    s.hostSays(CanopyLinkMethod.VIEWER_LOST, { viewerId: "v2" });
    expect(s.sent).toEqual([
      { webContentsId: VIEW + 1, event: { kind: "resync", hostId: "studio" } },
    ]);
  });

  it("sends a release again while the host is up but didn't take it", async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.client.invoke(VIEW, "studio", "canopy:get-snapshot", []);
    const busy = () => new AppError({ code: "RATE_LIMITED", message: "busy" });
    s.releaseFailures.push(...Array.from({ length: RELEASE_RETRIES + 2 }, busy));
    s.client.release(VIEW, "studio");
    await vi.advanceTimersByTimeAsync(RELEASE_RETRY_MS * RELEASE_RETRIES * RELEASE_RETRIES);
    const releases = s.connections
      .get("studio")!
      .calls.filter(([method]) => method === CanopyLinkMethod.RELEASE);
    expect(releases).toHaveLength(RELEASE_RETRIES);
  });

  it("doesn't resend a release once the link that held the viewer is gone", async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.client.invoke(VIEW, "studio", "canopy:get-snapshot", []);
    s.releaseFailures.push(new AppError({ code: "HOST_DISCONNECTED", message: "gone" }));
    s.client.release(VIEW, "studio");
    await vi.advanceTimersByTimeAsync(RELEASE_RETRY_MS * 10);
    const releases = s.connections
      .get("studio")!
      .calls.filter(([method]) => method === CanopyLinkMethod.RELEASE);
    expect(releases).toHaveLength(1);
  });
});
