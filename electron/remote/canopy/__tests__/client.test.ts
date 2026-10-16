import { describe, expect, it, vi } from "vitest";
import type { CanopyHostEvent } from "../../../../shared/types/ipc/canopyHost.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { EventMessage } from "../../link/messages.js";
import { CanopyHostsClient, type CanopyHostConnection } from "../client.js";
import { CANOPY_VIEWER_ENDPOINT_PREFIX, CanopyLinkMethod } from "../linkMethods.js";
import { CanopyViewers } from "../viewer.js";

const VIEW = 7;

function setup(options: { hostForView?: (id: number) => string | null } = {}) {
  const hosts = new Set(["studio", "attic"]);
  const connections = new Map<string, CanopyHostConnection & { calls: unknown[][] }>();
  const connection = (hostId: string) => {
    const calls: unknown[][] = [];
    const conn = {
      calls,
      callHost: vi.fn(async (method: string, payload: unknown) => {
        calls.push([method, payload]);
        return method === CanopyLinkMethod.INVOKE ? wrapSuccess({ from: hostId }) : null;
      }),
    };
    connections.set(hostId, conn);
    return conn;
  };
  connection("studio");
  connection("attic");
  const useChecks: Array<(hostId: string) => boolean> = [];
  const sessionListeners: Array<(hostId: string) => void> = [];
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
        sessionListeners.push(listener);
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
    sessionOpened: (hostId: string) => sessionListeners.forEach((l) => l(hostId)),
    viewerEvent: (hostId: string, event: EventMessage) =>
      viewerListeners.forEach((l) => l(hostId, event)),
    registryChanged: () => registryListeners.forEach((l) => l()),
  };
}

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
});
