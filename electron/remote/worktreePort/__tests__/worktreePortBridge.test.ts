import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function setup() {
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
  });
  const relay: WorktreePortClientRelay = new WorktreePortClientRelay({
    endpointId: "ep-1",
    deliver: () => {
      renderer?.close();
      renderer = new FakePeer();
      relay.setRendererPort(renderer.port);
    },
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
    async connect() {
      const pair = await openSessionPair(dir);
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
