import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lane } from "../../link/frames.js";
import { InteractiveKind } from "../../link/messages.js";
import { DEFAULT_LANE_LIMITS } from "../../link/scheduler.js";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import { FakePeer } from "../../terminal/__tests__/streamTestUtils.js";
import { WorktreePortClientRelay, WorktreePortHostBridge } from "../WorktreePortBridge.js";

let dir: string;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await removeTempDir(dir);
});

const PROJECT_ROOT = "/repos/project-a";

const event = (type: string) => ({ type: "event", event: { type, worktree: { id: "w" } } });

const VIEW_PORT_OPEN = { type: "view-port", open: true };
const VIEW_PORT_CLOSED = { type: "view-port", open: false };

const isViewPort = (open: boolean) => (message: unknown) =>
  (message as { type?: unknown; open?: unknown }).type === "view-port" &&
  (message as { open?: unknown }).open === open;

/** Record what crosses the link for the endpoint, in each direction, from now on. */
function tap(h: { hostSession(): LinkSession; clientSession(): LinkSession }) {
  const shellFrames: unknown[] = [];
  const hostHeard: unknown[] = [];
  h.clientSession().on(Lane.INTERACTIVE, InteractiveKind.WORKTREE_PORT, (body) => {
    if (body.endpointId === "ep-1") shellFrames.push(body.message);
  });
  h.hostSession().on(Lane.INTERACTIVE, InteractiveKind.WORKTREE_PORT, (body) => {
    if (body.endpointId === "ep-1") hostHeard.push(body.message);
  });
  return { shellFrames, hostHeard };
}

async function setup(projectRoot: string | null = PROJECT_ROOT, mayDrive?: () => boolean) {
  let workspace: FakePeer | null = null;
  let renderer: FakePeer | null = null;
  const opened: string[] = [];
  let released = 0;
  let closedViews = 0;

  const bridge: WorktreePortHostBridge = new WorktreePortHostBridge({
    endpointId: "ep-1",
    open: (projectId) => {
      opened.push(projectId);
      workspace?.close();
      workspace = new FakePeer();
      bridge.setPort(workspace.port);
    },
    release: () => {
      released++;
      workspace?.close();
    },
    resolveProjectRoot: (projectId) => (projectId === "project-a" ? projectRoot : null),
    ...(mayDrive ? { mayDrive } : {}),
  });
  let delivers = true;
  const deliver = () => {
    if (!delivers) return;
    renderer?.close();
    renderer = new FakePeer();
    relay.setRendererPort(renderer.port);
  };
  const relay: WorktreePortClientRelay = new WorktreePortClientRelay({
    endpointId: "ep-1",
    deliver,
    close: () => {
      closedViews++;
      renderer?.close();
    },
  });
  bridge.setProject("project-a");
  cleanups.push(() => {
    relay.dispose();
    bridge.dispose();
    workspace?.close();
    renderer?.close();
  });

  let host: LinkSession | null = null;
  let client: LinkSession | null = null;
  return {
    bridge,
    relay,
    workspace: () => workspace!,
    renderer: () => renderer!,
    opened,
    released: () => released,
    closedViews: () => closedViews,
    /** Post the view a fresh port, as a cached view's reactivation does. */
    redeliver: deliver,
    /** Deliver no port from now on, as when the view is gone or the broker refuses it. */
    failDelivery() {
      delivers = false;
    },
    hostSession: () => host!,
    clientSession: () => client!,
    async connect(clientOptions: Parameters<typeof openSessionPair>[2] = {}) {
      const pair = await openSessionPair(dir, {}, clientOptions);
      host = pair.host;
      client = pair.client;
      cleanups.push(() => {
        pair.host.close("test done");
        pair.client.close("test done");
      });
      bridge.attach(pair.host);
      relay.attach(pair.client);
    },
    async drop() {
      const closed = new Promise((resolve) => host!.onClose(resolve));
      client!.close("network gone");
      await closed;
      await waitFor(() => !relay.isAttached);
    },
  };
}

describe("worktree port over the link", () => {
  it("carries a request to the workspace host and its response back", async () => {
    const h = await setup();
    await h.connect();

    h.renderer().post({ id: "worktree-1", action: "get-all-states", payload: {} });
    await waitFor(() => h.workspace().received.length === 1);
    expect(h.workspace().received[0]).toEqual({
      id: "worktree-1",
      action: "get-all-states",
      payload: {},
    });

    h.workspace().post({ id: "worktree-1", result: { states: [{ id: "w1" }] } });
    await waitFor(() => h.renderer().received.length === 1);
    expect(h.renderer().received[0]).toEqual({
      id: "worktree-1",
      result: { states: [{ id: "w1" }] },
    });
  });

  it("lets only the project's driver change its worktrees, while anyone may read them", async () => {
    let driving = false;
    const h = await setup(PROJECT_ROOT, () => driving);
    await h.connect();
    h.renderer().post({
      id: "del",
      action: "delete-worktree",
      payload: { worktreeId: "/w/a", force: true },
    });
    h.renderer().post({ id: "read", action: "get-all-states", payload: {} });
    await waitFor(() => h.renderer().received.length === 1 && h.workspace().received.length === 1);
    expect(h.renderer().received[0]).toMatchObject({
      id: "del",
      error: expect.stringContaining("has control of this project"),
    });
    expect(h.workspace().received).toEqual([{ id: "read", action: "get-all-states", payload: {} }]);

    driving = true;
    h.renderer().post({ id: "del2", action: "delete-worktree", payload: { worktreeId: "/w/a" } });
    await waitFor(() => h.workspace().received.length === 2);
    expect(h.workspace().received[1]).toMatchObject({ id: "del2", action: "delete-worktree" });
  });

  it("holds every action that changes the project to the lease, and lets a resource's status through", async () => {
    const h = await setup(PROJECT_ROOT, () => false);
    await h.connect();
    const changes: Array<[string, unknown]> = [
      [
        "create-worktree",
        { rootPath: PROJECT_ROOT, options: { baseBranch: "main", newBranch: "x", path: "/w/x" } },
      ],
      ["delete-worktree", { worktreeId: "/w/a" }],
      ["set-active", { worktreeId: "/w/a" }],
      ["run-lifecycle-setup", { worktreeId: "/w/a" }],
      ["approve-lifecycle-commands", { worktreeId: "/w/a", fingerprint: "f" }],
      ["switch-worktree-environment", { worktreeId: "/w/a", envKey: "dev" }],
      ["resource-action", { worktreeId: "/w/a", action: "teardown" }],
    ];
    changes.forEach(([action, payload], i) => h.renderer().post({ id: `c${i}`, action, payload }));
    h.renderer().post({
      id: "status",
      action: "resource-action",
      payload: { worktreeId: "/w/a", action: "status" },
    });
    await waitFor(
      () => h.renderer().received.length === changes.length && h.workspace().received.length === 1
    );
    expect(
      h.renderer().received.every((m) => typeof (m as { error?: unknown }).error === "string")
    ).toBe(true);
    expect(h.workspace().received).toEqual([
      {
        id: "status",
        action: "resource-action",
        payload: { worktreeId: "/w/a", action: "status" },
      },
    ]);
  });

  it("carries error responses and pushed events", async () => {
    const h = await setup();
    await h.connect();

    h.workspace().post({ id: "worktree-2", error: "boom" });
    h.workspace().post({
      type: "event",
      event: { type: "worktree-update", worktree: { id: "w" } },
    });
    await waitFor(() => h.renderer().received.length === 2);
    expect(h.renderer().received).toEqual([
      { id: "worktree-2", error: "boom" },
      { type: "event", event: { type: "worktree-update", worktree: { id: "w" } } },
    ]);
  });

  it("drops malformed requests instead of passing them to the workspace host", async () => {
    const h = await setup();
    await h.connect();

    h.renderer().post({ action: "get-all-states" });
    h.renderer().post("not an object");
    h.renderer().post({ id: "ok", action: "refresh" });
    await waitFor(() => h.workspace().received.length === 1);
    expect(h.workspace().received[0]).toMatchObject({ id: "ok", action: "refresh" });
  });

  it("closes the view's port when the link drops and posts a fresh one on reconnect", async () => {
    const h = await setup();
    await h.connect();
    const firstRenderer = h.renderer();

    await h.drop();
    expect(h.closedViews()).toBe(1);
    expect(h.released()).toBe(1);

    await h.connect();
    expect(h.renderer()).not.toBe(firstRenderer);
    expect(h.opened).toEqual(["project-a", "project-a"]);

    h.renderer().post({ id: "worktree-3", action: "refresh" });
    await waitFor(() => h.workspace().received.length === 1);
  });

  it("sends no worktree events for a view whose port is closed until it gets a fresh one", async () => {
    const h = await setup();
    await h.connect();
    const t = tap(h);

    // Caching closes the view's port.
    h.renderer().close();
    await waitFor(() => t.hostHeard.some(isViewPort(false)));
    h.workspace().post(event("worktree-update"));
    h.workspace().post(event("worktree-tick"));
    h.workspace().post(event("pr-detected"));
    h.workspace().post({ id: "late", result: null });
    await waitFor(() => t.shellFrames.length > 0);
    expect(t.shellFrames).toEqual([{ id: "late", result: null }]);
    expect(h.bridge.hasPort).toBe(true);
    expect(h.released()).toBe(0);

    // Reactivation: the resume is on the link before the view holds its end,
    // so it goes ahead of the view's first request.
    const posted = vi.spyOn(h.clientSession(), "post");
    h.redeliver();
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ body: { endpointId: "ep-1", message: VIEW_PORT_OPEN } })
    );
    h.renderer().post({ id: "refetch", action: "get-all-states", payload: {} });
    await waitFor(() => h.workspace().received.length === 1);
    expect(t.hostHeard).toEqual([
      VIEW_PORT_CLOSED,
      VIEW_PORT_OPEN,
      { id: "refetch", action: "get-all-states", payload: {} },
    ]);
    h.workspace().post(event("worktree-update"));
    await waitFor(() => h.renderer().received.length === 1);
    expect(h.renderer().received).toEqual([event("worktree-update")]);
  });

  it("retries a resume the full link refused, before the view asks for anything", async () => {
    const h = await setup();
    await h.connect({
      laneLimits: {
        ...DEFAULT_LANE_LIMITS,
        [Lane.INTERACTIVE]: { ...DEFAULT_LANE_LIMITS[Lane.INTERACTIVE], maxFrames: 1 },
      },
    });
    const t = tap(h);
    h.renderer().close();
    await waitFor(() => t.hostHeard.some(isViewPort(false)));

    // Another endpoint's frame fills the lane, so the resume is refused.
    expect(
      h.clientSession().post({
        lane: Lane.INTERACTIVE,
        kind: InteractiveKind.WORKTREE_PORT,
        body: { endpointId: "ep-other", message: { id: "x", action: "refresh" } },
      })
    ).not.toBe("refused");
    h.redeliver();
    await waitFor(() => t.hostHeard.some(isViewPort(true)));
    h.workspace().post(event("worktree-tick"));
    await waitFor(() => h.renderer().received.length === 1);
    expect(h.renderer().received).toEqual([event("worktree-tick")]);
    expect(t.hostHeard).toEqual([VIEW_PORT_CLOSED, VIEW_PORT_OPEN]);
  });

  it("takes the view's request as its resume when the resume itself was refused", async () => {
    const h = await setup();
    await h.connect();
    const t = tap(h);
    h.renderer().close();
    await waitFor(() => t.hostHeard.some(isViewPort(false)));

    vi.spyOn(h.clientSession(), "post").mockImplementationOnce(() => "refused");
    h.redeliver();
    h.renderer().post({ id: "r", action: "refresh" });
    await waitFor(() => h.workspace().received.length === 1);
    h.workspace().post(event("worktree-tick"));
    await waitFor(() => h.renderer().received.length === 1);
    expect(h.renderer().received).toEqual([event("worktree-tick")]);

    // The host already resumed, so no resume follows, and the next close pauses it again.
    h.renderer().close();
    await waitFor(() => t.hostHeard.length === 3);
    expect(t.hostHeard).toEqual([
      VIEW_PORT_CLOSED,
      { id: "r", action: "refresh" },
      VIEW_PORT_CLOSED,
    ]);
  });

  it("starts every session sending events, whatever the last one was told", async () => {
    const h = await setup();
    await h.connect();
    const first = tap(h);
    h.renderer().close();
    await waitFor(() => first.hostHeard.some(isViewPort(false)));

    await h.drop();
    await h.connect();
    const t = tap(h);
    h.workspace().post(event("worktree-update"));
    await waitFor(() => h.renderer().received.length === 1);
    expect(h.renderer().received).toEqual([event("worktree-update")]);
    expect(t.hostHeard).toEqual([]);
  });

  it("pauses a new session's events when the view gets no port from it", async () => {
    const h = await setup();
    await h.connect();
    await h.drop();
    h.failDelivery();
    await h.connect();
    const t = tap(h);
    await waitFor(() => t.hostHeard.some(isViewPort(false)));

    h.workspace().post(event("worktree-update"));
    h.workspace().post({ id: "late", result: null });
    await waitFor(() => t.shellFrames.length > 0);
    expect(t.shellFrames).toEqual([{ id: "late", result: null }]);
  });

  it("forgets the view's port when the link drops, even if its close never comes", async () => {
    const h = await setup();
    await h.connect();
    const stuck = { postMessage() {}, onMessage() {}, onClose() {}, close: vi.fn() };
    h.relay.setRendererPort(stuck);
    await h.drop();
    expect(stuck.close).toHaveBeenCalled();

    h.failDelivery();
    await h.connect();
    const t = tap(h);
    await waitFor(() => t.hostHeard.some(isViewPort(false)));
  });

  it("keeps sending events to a view whose port was replaced", async () => {
    const h = await setup();
    await h.connect();
    const t = tap(h);
    const closed = (peer: FakePeer) =>
      new Promise<void>((resolve) => peer.port.onClose(() => resolve()));

    const firstClosed = closed(h.renderer());
    h.redeliver();
    const secondClosed = closed(h.renderer());
    h.redeliver();
    await Promise.all([firstClosed, secondClosed]);

    h.workspace().post(event("worktree-update"));
    h.workspace().post({ id: "fence", result: null });
    await waitFor(() => h.renderer().received.length === 2);
    expect(h.renderer().received).toEqual([
      event("worktree-update"),
      { id: "fence", result: null },
    ]);
    h.renderer().post({ id: "still-here", action: "refresh" });
    await waitFor(() => h.workspace().received.length === 1);
    expect(t.hostHeard).toEqual([{ id: "still-here", action: "refresh" }]);
  });

  it("answers at once when the workspace host is not connected", async () => {
    const h = await setup();
    await h.connect();
    h.workspace().close();
    await waitFor(() => !h.bridge.hasPort);

    h.renderer().post({ id: "worktree-4", action: "refresh" });
    await waitFor(() => h.renderer().received.length === 1);
    expect(h.renderer().received[0]).toMatchObject({ id: "worktree-4" });
    expect(typeof h.renderer().received[0]!.error).toBe("string");
  });
});

describe("worktree requests from a remote endpoint", () => {
  it("forwards a request naming the endpoint's own project root", async () => {
    const h = await setup();
    await h.connect();

    h.renderer().post({ id: "b-1", action: "list-branches", payload: { rootPath: PROJECT_ROOT } });
    h.renderer().post({
      id: "b-2",
      action: "has-resource-config",
      payload: { rootPath: `${PROJECT_ROOT}/` },
    });
    await waitFor(() => h.workspace().received.length === 2);
    expect(h.workspace().received[0]).toEqual({
      id: "b-1",
      action: "list-branches",
      payload: { rootPath: PROJECT_ROOT },
    });
  });

  it.each([
    ["another project's root", "/repos/project-b"],
    ["a parent of the root", "/repos"],
    ["a path under the root", `${PROJECT_ROOT}/sub`],
    ["a relative path", "project-a"],
    ["a traversal back out", `${PROJECT_ROOT}/../project-b`],
  ])("refuses %s and fails the request instead of forwarding it", async (_label, rootPath) => {
    const h = await setup();
    await h.connect();

    h.renderer().post({
      id: "c-1",
      action: "create-worktree",
      payload: { rootPath, options: { baseBranch: "main", newBranch: "x", path: "/tmp/x" } },
    });
    await waitFor(() => h.renderer().received.length === 1);
    expect(h.renderer().received[0]).toEqual({ id: "c-1", error: "Path is outside this project" });
    expect(h.workspace().received).toEqual([]);
  });

  it("refuses every path-bearing request when the project has no known root", async () => {
    const h = await setup(null);
    await h.connect();

    h.renderer().post({ id: "r-1", action: "get-recent-branches", payload: { rootPath: "/x" } });
    await waitFor(() => h.renderer().received.length === 1);
    expect(h.renderer().received[0]).toMatchObject({ id: "r-1", error: expect.any(String) });
    expect(h.workspace().received).toEqual([]);
  });

  it("refuses actions outside the protocol and payloads that don't match it", async () => {
    const h = await setup();
    await h.connect();

    h.renderer().post({ id: "x-1", action: "run-shell", payload: { cmd: "rm -rf /" } });
    h.renderer().post({ id: "x-2", action: "set-active", payload: {} });
    h.renderer().post({
      id: "x-3",
      action: "resource-action",
      payload: { worktreeId: "w", action: "format-disk" },
    });
    h.renderer().post({ id: "x-4", action: "delete-worktree", payload: { worktreeId: 7 } });
    await waitFor(() => h.renderer().received.length === 4);
    for (const reply of h.renderer().received) {
      expect(typeof (reply as { error?: unknown }).error).toBe("string");
    }
    expect(h.workspace().received).toEqual([]);
  });

  it("forwards only the fields the protocol defines", async () => {
    const h = await setup();
    await h.connect();

    h.renderer().post({
      id: "d-1",
      action: "delete-worktree",
      payload: { worktreeId: "/repos/wt", force: true, rootPath: "/elsewhere" },
    });
    await waitFor(() => h.workspace().received.length === 1);
    expect(h.workspace().received[0]).toEqual({
      id: "d-1",
      action: "delete-worktree",
      payload: { worktreeId: "/repos/wt", force: true },
    });
  });
});
