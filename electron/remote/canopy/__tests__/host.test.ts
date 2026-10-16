import { describe, expect, it, vi } from "vitest";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { LinkSession } from "../../link/session.js";
import { installCanopyHostWith, type CanopySessionContext } from "../host.js";
import { CANOPY_VIEWER_ENDPOINT_PREFIX, CanopyLinkMethod } from "../linkMethods.js";
import { CanopyViewers } from "../viewer.js";

function fakeSession(postResult: () => string) {
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

function setup(postResult: () => string = () => "queued") {
  const endpoints: ClientEndpoint[] = [];
  const viewers = new CanopyViewers({
    source: { observeCanopy: () => () => {}, observeFleet: () => null },
    invoke: async ({ endpoint }) => {
      endpoints.push(endpoint);
      endpoint.send({ type: "event", channel: "canopy:terminal-data", args: [{ kind: "data" }] });
      return wrapSuccess(null);
    },
  });
  const link = fakeSession(postResult);
  const ctx: CanopySessionContext = {
    session: link.session,
    client: { clientId: "shell-1", clientName: "mbp", platform: "darwin" },
    sessionId: "s1",
  };
  installCanopyHostWith({ sessions: [ctx], onSession: () => () => {} }, viewers);
  const invoke = (viewerId: string) =>
    link.shellCalls(CanopyLinkMethod.INVOKE, {
      viewerId,
      channel: "canopy:watch-terminal",
      args: [],
    });
  return { link, endpoints, viewers, invoke };
}

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
});
