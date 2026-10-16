import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { LinkSession } from "../../link/session.js";
import {
  VIEWER_LOST_RETRIES,
  VIEWER_LOST_RETRY_MS,
  installCanopyHostWith,
  type CanopySessionContext,
} from "../host.js";
import { CANOPY_VIEWER_ENDPOINT_PREFIX, CanopyLinkMethod } from "../linkMethods.js";
import { CanopyViewers } from "../viewer.js";
import { Lane } from "../../link/frames.js";
import { EventKind, InteractiveKind } from "../../link/messages.js";

function fakeSession(postResult: () => string, callFailures: Error[] = []) {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const closeListeners: Array<() => void> = [];
  const posts: unknown[] = [];
  const calls: unknown[][] = [];
  const session = {
    isOpen: true,
    registerCallHandler: (method: string, _schema: unknown, handler: (p: unknown) => unknown) => {
      handlers.set(method, handler);
      return () => {};
    },
    post: (message: unknown) => {
      posts.push(message);
      return postResult();
    },
    call: vi.fn(async (method: string, payload: unknown) => {
      calls.push([method, payload]);
      const failure = callFailures.shift();
      if (failure) throw failure;
      return null;
    }),
    onClose: (listener: () => void) => {
      closeListeners.push(listener);
      return () => {};
    },
  };
  return {
    session: session as unknown as LinkSession,
    posts,
    calls,
    shellCalls: (method: string, payload: unknown) => handlers.get(method)!(payload),
    close: () => closeListeners.forEach((listener) => listener()),
  };
}

function setup(
  postResult: () => string = () => "queued",
  callFailures: Error[] = [],
  alsoSnapshot = false
) {
  const endpoints: ClientEndpoint[] = [];
  const viewers = new CanopyViewers({
    source: { observeCanopy: () => () => {}, observeFleet: () => null },
    invoke: async ({ endpoint }) => {
      endpoints.push(endpoint);
      endpoint.send({ type: "event", channel: "canopy:terminal-data", args: [{ kind: "data" }] });
      if (alsoSnapshot) {
        endpoint.send({ type: "event", channel: "canopy:snapshot-updated", args: [{ runs: [] }] });
      }
      return wrapSuccess(null);
    },
  });
  const link = fakeSession(postResult, callFailures);
  const ctx: CanopySessionContext = {
    session: link.session,
    client: { clientId: "shell-1", clientName: "mbp", platform: "darwin" },
    sessionId: "s1",
  };
  installCanopyHostWith({ sessions: [ctx], onSession: () => () => {} }, viewers);
  const invoke = (viewerId: string, interactive?: boolean) =>
    link.shellCalls(CanopyLinkMethod.INVOKE, {
      viewerId,
      channel: "canopy:watch-terminal",
      args: [],
      ...(interactive === undefined ? {} : { interactive }),
    });
  return { link, endpoints, viewers, invoke };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("installCanopyHostWith", () => {
  it("addresses a viewer's pushes to it, as the Shell named it", async () => {
    const s = setup();
    await s.invoke("v1");
    expect(s.link.posts).toEqual([
      expect.objectContaining({
        body: {
          endpointId: CANOPY_VIEWER_ENDPOINT_PREFIX + "v1",
          channel: "canopy:terminal-data",
          args: [{ kind: "data" }],
        },
      }),
    ]);
    expect(s.endpoints[0].clientId).toBe("shell-1");
  });

  it("drops a viewer whose push the link refused, and tells the Shell to read again", async () => {
    const s = setup(() => "refused");
    await s.invoke("v1");
    await vi.waitFor(() =>
      expect(s.link.calls).toEqual([[CanopyLinkMethod.VIEWER_LOST, { viewerId: "v1" }]])
    );
    expect(s.endpoints[0].isClosed()).toBe(true);
    // Its next call starts a fresh viewer.
    await s.invoke("v1");
    expect(s.endpoints[1]).not.toBe(s.endpoints[0]);
  });

  it("ends every viewer of a link when it closes, and a release ends just one", async () => {
    const s = setup();
    await s.invoke("v1");
    await s.invoke("v2");
    s.link.shellCalls(CanopyLinkMethod.RELEASE, { viewerId: "v1" });
    expect(s.endpoints.map((endpoint) => endpoint.isClosed())).toEqual([true, false]);
    s.link.close();
    expect(s.endpoints[1].isClosed()).toBe(true);
  });

  it("says a viewer was lost again while the link is up but the Shell didn't take it", async () => {
    vi.useFakeTimers();
    const busy = Array.from({ length: VIEWER_LOST_RETRIES + 2 }, () => new Error("RATE_LIMITED"));
    const s = setup(() => "refused", busy);
    await s.invoke("v1");
    await vi.advanceTimersByTimeAsync(
      VIEWER_LOST_RETRY_MS * VIEWER_LOST_RETRIES * VIEWER_LOST_RETRIES
    );
    expect(s.link.calls).toHaveLength(VIEWER_LOST_RETRIES);
  });

  it("streams a viewer's terminal on the interactive lane once its Shell asks, its own flow", async () => {
    const s = setup(() => "queued", [], true);
    await s.invoke("v1", true);
    const endpointId = CANOPY_VIEWER_ENDPOINT_PREFIX + "v1";
    expect(s.link.posts).toEqual([
      {
        lane: Lane.INTERACTIVE,
        kind: InteractiveKind.CANOPY_TERMINAL,
        body: { endpointId, channel: "canopy:terminal-data", args: [{ kind: "data" }] },
      },
      // Snapshots are no terminal's echo: they stay events.
      {
        lane: Lane.EVENTS,
        kind: EventKind.EVENT,
        body: { endpointId, channel: "canopy:snapshot-updated", args: [{ runs: [] }] },
      },
    ]);
  });

  it("keeps a Shell that never asked on events, where an interactive kind it doesn't know can't end its link", async () => {
    const s = setup();
    await s.invoke("v1");
    expect(s.link.posts).toEqual([expect.objectContaining({ lane: Lane.EVENTS })]);
  });

  it("drops a viewer whose interactive push the link refused, as it does an event's", async () => {
    const s = setup(() => "refused");
    await s.invoke("v1", true);
    await vi.waitFor(() =>
      expect(s.link.calls).toEqual([[CanopyLinkMethod.VIEWER_LOST, { viewerId: "v1" }]])
    );
  });
});
