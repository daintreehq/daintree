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
      [
        CanopyLinkMethod.INVOKE,
        { viewerId: "v1", channel: "canopy:get-snapshot", args: [], interactive: true },
      ],
    ]);
    expect(s.touched).toContain("studio");
  });

  it("types into and answers the run it shows, on the host it is on", async () => {
    const s = setup();
    await s.client.invoke(VIEW, "studio", "canopy:terminal-input", [3, "y"]);
    await s.client.invoke(VIEW, "studio", "canopy:answer", ["run-1", { spawnedAt: 1 }, "Yes"]);
    expect(s.connections.get("studio")!.calls.map(([, payload]) => payload)).toEqual([
      { viewerId: "v1", channel: "canopy:terminal-input", args: [3, "y"], interactive: true },
      {
        viewerId: "v1",
        channel: "canopy:answer",
        args: ["run-1", { spawnedAt: 1 }, "Yes"],
        interactive: true,
      },
    ]);
  });

  it("refuses resizing a run's terminal, and any channel outside Canopy's reads and actions", async () => {
    const s = setup();
    for (const channel of ["canopy:terminal-resize", "terminal:write"]) {
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

  it("takes an unwatch for a host the view no longer reads without opening a viewer to say it", async () => {
    const s = setup();
    await s.client.invoke(VIEW, "studio", "canopy:watch-terminal", []);
    s.client.release(VIEW, "studio");
    const before = s.connections.get("studio")!.calls.length;
    await expect(
      s.client.invoke(VIEW, "studio", "canopy:unwatch-terminal", [])
    ).resolves.toBeUndefined();
    expect(s.connections.get("studio")!.calls.slice(before)).toEqual([]);
    expect(s.inUse("studio")).toBe(false);
  });
});

describe("CanopyHostsClient: assistant viewers (#14163)", () => {
  const subject = {
    hostId: "studio",
    scope: { kind: "project" as const, projectId: "p1" },
    terminalId: "t1",
    incarnation: 4,
    lane: 1,
  };

  /** The host answers each assistant call as `answer` says, after recording it. */
  function answering(
    s: ReturnType<typeof setup>,
    hostId: string,
    answer: (method: string, payload: unknown) => unknown
  ) {
    const conn = s.connections.get(hostId)!;
    vi.mocked(conn.callHost).mockImplementation(async (method: string, payload: unknown) => {
      conn.calls.push([method, payload]);
      return answer(method, payload);
    });
    return conn;
  }

  it("names the subject's host to the host as its own, and the watch as the consumer's viewer", async () => {
    const s = setup();
    const conn = answering(s, "studio", () => wrapSuccess({ watchId: 5, snapshot: null }));
    await expect(s.client.watchAssistant(VIEW, "pick", subject)).resolves.toEqual({
      watchId: 5,
      snapshot: null,
    });
    expect(conn.calls).toEqual([
      [
        CanopyLinkMethod.ASSISTANT_INVOKE,
        {
          viewerId: "v1",
          channel: "canopy:watch-assistant-terminal",
          args: [{ ...subject, hostId: "local" }],
          interactive: true,
        },
      ],
    ]);
    expect(s.inUse("studio")).toBe(true);
  });

  it("reads assistants on the host a view is bound to, but never This Mac's from its own view", async () => {
    const bound = setup({ hostForView: () => "studio" });
    answering(bound, "studio", () => wrapSuccess({ watchId: 1, snapshot: null }));
    await expect(bound.client.watchAssistant(VIEW, "pick", subject)).resolves.toMatchObject({
      watchId: 1,
    });
    const own = setup();
    await expect(
      own.client.watchAssistant(VIEW, "pick", { ...subject, hostId: "local" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a subject naming a host outside the host list, or a malformed one", async () => {
    const s = setup();
    await expect(
      s.client.watchAssistant(VIEW, "pick", { ...subject, hostId: "elsewhere" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      s.client.watchAssistant(VIEW, "pick", { ...subject, incarnation: -1 })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(s.client.watchAssistant(VIEW, "../x", subject)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(s.connections.get("studio")!.calls).toEqual([]);
  });

  it("says a host from before the assistant viewer has none, and its workers still read", async () => {
    const s = setup();
    answering(s, "studio", (method) => {
      if (method === CanopyLinkMethod.INVOKE) return wrapSuccess({ from: "studio" });
      throw new AppError({ code: "UNSUPPORTED", message: `Unknown method: ${method}` });
    });
    await expect(s.client.watchAssistant(VIEW, "pick", subject)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      userMessage: expect.stringContaining("newer Daintree"),
    });
    await expect(s.client.listAssistants(VIEW, "studio")).resolves.toEqual({
      hostId: "studio",
      version: null,
      directory: {
        coverage: "unsupported",
        observedAt: null,
        complete: false,
        omitted: 0,
        entries: [],
      },
    });
    await expect(s.client.invoke(VIEW, "studio", "canopy:get-snapshot", [])).resolves.toEqual({
      from: "studio",
    });
  });

  it("lists a host's assistants as this Shell names it, never as the host named itself", async () => {
    const s = setup();
    answering(s, "studio", () => ({
      version: 1,
      directory: {
        coverage: "ok",
        observedAt: 10,
        complete: false,
        omitted: 2,
        entries: [
          {
            state: "live",
            role: "assistant",
            subject: { ...subject, hostId: "local" },
            agentId: "claude",
            agentState: "idle",
            waitingReason: null,
            since: null,
            label: null,
            attached: false,
            handback: null,
          },
          {
            state: "live",
            role: "worker",
            subject: { ...subject, hostId: "local", terminalId: "w1", lane: undefined },
            agentId: "claude",
            agentState: "working",
            waitingReason: null,
            since: null,
            label: null,
            attached: null,
            handback: null,
          },
          {
            state: "resumable",
            role: "assistant",
            hostId: "local",
            scope: { kind: "project", projectId: "p1" },
            lane: 0,
            agentId: null,
            capturedAt: 1,
          },
        ],
      },
    }));
    const listed = await s.client.listAssistants(VIEW, "studio", "p1");
    expect(listed.version).toBe(1);
    // What the host couldn't fit is still said: the picker never takes it for every assistant.
    expect(listed.directory).toMatchObject({ coverage: "ok", complete: false, omitted: 2 });
    expect(
      listed.directory.entries.map((entry) =>
        entry.state === "live" ? entry.subject.hostId : entry.hostId
      )
    ).toEqual(["studio", "studio"]);
    expect(s.connections.get("studio")!.calls).toEqual([
      [CanopyLinkMethod.ASSISTANTS, { projectId: "p1" }],
    ]);
  });

  it("keeps an assistant viewer's stream apart from the host's Canopy panel and other consumers", async () => {
    const s = setup();
    answering(s, "studio", () => wrapSuccess({ watchId: 1, snapshot: null }));
    await s.client.invoke(VIEW, "studio", "canopy:get-snapshot", []);
    await s.client.watchAssistant(VIEW, "pick", subject);
    await s.client.watchAssistant(VIEW, "row", subject);
    const event = (viewerId: string, channel: string): EventMessage => ({
      endpointId: CANOPY_VIEWER_ENDPOINT_PREFIX + viewerId,
      channel,
      args: [{ kind: "data", watchId: 1 }],
    });
    s.viewerEvent("studio", event("v2", "canopy:terminal-data"));
    s.viewerEvent("studio", event("v2", "canopy:snapshot-updated"));
    s.viewerEvent("attic", event("v3", "canopy:terminal-data"));
    expect(s.sent).toEqual([
      {
        webContentsId: VIEW,
        event: {
          kind: "assistant-terminal-data",
          hostId: "studio",
          consumer: "pick",
          chunk: { kind: "data", watchId: 1 },
        },
      },
    ]);
  });

  it("types only through a watch the consumer holds, and never sends an unknown delivery again", async () => {
    const s = setup();
    const conn = answering(s, "studio", (_method, payload) => {
      const channel = (payload as { channel: string }).channel;
      if (channel === "canopy:terminal-submit") {
        throw new AppError({ code: "OUTCOME_UNKNOWN", message: "link closed" });
      }
      return wrapSuccess(channel === "canopy:watch-assistant-terminal" ? { watchId: 2 } : null);
    });
    await expect(
      s.client.assistantInvoke(VIEW, "pick", "canopy:terminal-input", [2, "x"])
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      s.client.assistantInvoke(VIEW, "pick", "canopy:unwatch-terminal", [])
    ).resolves.toBeUndefined();
    expect(conn.calls).toEqual([]);

    await s.client.watchAssistant(VIEW, "pick", subject);
    await expect(
      s.client.assistantInvoke(VIEW, "pick", "canopy:terminal-submit", [2, "hi"])
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      userMessage: expect.stringContaining("may not have reached"),
    });
    expect(
      conn.calls.filter(
        ([, payload]) => (payload as { channel: string }).channel === "canopy:terminal-submit"
      )
    ).toHaveLength(1);
    await expect(
      s.client.assistantInvoke(VIEW, "pick", "canopy:terminal-resize", [2, 80, 24])
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("answers a watch the consumer let go of while the host answered as no stream", async () => {
    const s = setup();
    let release: (value: unknown) => void = () => {};
    answering(
      s,
      "studio",
      (method) =>
        new Promise((resolve) => {
          if (method === CanopyLinkMethod.ASSISTANT_INVOKE) release = resolve;
          else resolve(null);
        })
    );
    const pending = s.client.watchAssistant(VIEW, "pick", subject);
    await Promise.resolve();
    s.client.releaseAssistant(VIEW, "pick");
    release(wrapSuccess({ watchId: 9, snapshot: null }));
    await expect(pending).resolves.toEqual({ watchId: null, snapshot: null });
    expect(s.inUse("studio")).toBe(false);
  });

  it("releases the consumer's viewer on the host, and moves it when the assistant is elsewhere", async () => {
    const s = setup();
    answering(s, "studio", () => wrapSuccess({ watchId: 1, snapshot: null }));
    answering(s, "attic", () => wrapSuccess({ watchId: 1, snapshot: null }));
    await s.client.watchAssistant(VIEW, "pick", subject);
    await s.client.watchAssistant(VIEW, "pick", { ...subject, hostId: "attic" });
    expect(s.connections.get("studio")!.calls.at(-1)).toEqual([
      CanopyLinkMethod.RELEASE,
      { viewerId: "v1" },
    ]);
    s.client.releaseAssistant(VIEW, "pick");
    expect(s.connections.get("attic")!.calls.at(-1)).toEqual([
      CanopyLinkMethod.RELEASE,
      { viewerId: "v2" },
    ]);
    expect(s.inUse("studio")).toBe(false);
    expect(s.inUse("attic")).toBe(false);
  });

  it("tells only the assistant's consumer to read again, and drops it with its host", async () => {
    const s = setup();
    answering(s, "studio", () => wrapSuccess({ watchId: 1, snapshot: null }));
    await s.client.watchAssistant(VIEW, "pick", subject);
    s.sessionOpened("studio");
    s.hostSays(CanopyLinkMethod.VIEWER_LOST, { viewerId: "v1" });
    expect(s.sent.map(({ event }) => event)).toEqual([
      { kind: "assistant-resync", hostId: "studio", consumer: "pick" },
      { kind: "assistant-resync", hostId: "studio", consumer: "pick" },
    ]);
    s.hosts.delete("studio");
    s.registryChanged();
    expect(s.inUse("studio")).toBe(false);
  });

  it("resolves the subject on its own host and answers with the host this Shell knows", async () => {
    const s = setup();
    answering(s, "studio", () =>
      wrapSuccess({
        scope: "project",
        hostId: "local",
        projectId: "p1",
        lane: 1,
        terminalId: "t1",
        incarnation: 4,
      })
    );
    await expect(s.client.resolveAssistant(VIEW, "open", subject)).resolves.toMatchObject({
      hostId: "studio",
      projectId: "p1",
    });
  });
});
