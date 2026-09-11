import { describe, it, expect, vi, beforeEach } from "vitest";

import type { IpcContext } from "../../types.js";

/**
 * Who a native assistant session belongs to, decided at the IPC boundary.
 *
 * Both identities come from the IPC CONTEXT rather than the payload, and neither is
 * allowed a default. The window id in particular used to fall back to `0` — a value no
 * window ever has — which turned "this sender has no owner" from a refusal into a
 * session filed under a window that cannot be closed, crashed, or torn down, because it
 * does not exist. It would hold the project's engine lease against every later launch.
 */

/** Typed with its parameter so the call recorded below is readable, not `never`. */
const start = vi.fn(async (_opts: Record<string, unknown>) => ({
  sessionId: "ses_1",
  ready: null,
  replay: [],
  mcpUnavailableReason: null,
}));
const listResumable = vi.fn(async (_projectId: string) => [{ slot: 1, panelWasOpen: true }]);
const discardResume = vi.fn(
  async (_projectId: string, _slot: number, _webContentsId: number) => true
);

vi.mock("../../../services/assistant-host/AssistantHostService.js", () => ({
  assistantHostService: {
    start,
    send: vi.fn(),
    stop: vi.fn(),
    isOwnedBy: vi.fn(() => true),
    listResumable,
    discardResume,
  },
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: () => undefined },
}));

const { assistantHostNamespace } = await import("../assistantHost.js");

const handler = assistantHostNamespace.ops.start.handler as (
  ctx: IpcContext,
  payload: unknown
) => Promise<unknown>;
const listHandler = assistantHostNamespace.ops.listResumable.handler as (
  ctx: IpcContext,
  projectId: unknown
) => Promise<unknown>;
const discardHandler = assistantHostNamespace.ops.discardResume.handler as (
  ctx: IpcContext,
  projectId: unknown,
  slot: unknown
) => Promise<unknown>;

/**
 * An IPC context. `url` is the sender's document URL, which only the startup-restore
 * renderer carries a `?projectId=` on.
 */
function context(
  senderWindow: { id: number } | null,
  projectId: string | null = "p1",
  url?: string
): IpcContext {
  return {
    webContentsId: 7,
    senderWindow,
    projectId,
    ...(url ? { event: { sender: { getURL: () => url } } } : {}),
  } as unknown as IpcContext;
}

const STARTUP_URL = "app://daintree/index.html?projectId=p1";
const PAYLOAD = { projectId: "p1", cwd: "/tmp/project" };

describe("assistantHost.start ownership", () => {
  beforeEach(() => {
    start.mockClear();
  });

  it("takes both identities from the context, never the payload", async () => {
    await handler(context({ id: 42 }), {
      ...PAYLOAD,
      // A renderer nominating its own owner — and its own authority.
      windowId: 999,
      webContentsId: 999,
      tier: "system",
    });

    expect(start).toHaveBeenCalledTimes(1);
    const opts = start.mock.calls[0]![0];
    expect(opts.windowId).toBe(42);
    expect(opts.webContentsId).toBe(7);
    // A tier from the renderer must not reach the service at all: it would be a second
    // answer to a question the engine refuses to boot on a disagreement over.
    expect(opts).not.toHaveProperty("tier");
  });

  it("refuses a start from a sender with no owning window", async () => {
    await expect(handler(context(null), PAYLOAD)).rejects.toThrow(/owning window/i);
    // The point of refusing rather than defaulting: nothing was spawned, so there is no
    // unreclaimable session and no held lease.
    expect(start).not.toHaveBeenCalled();
  });
});

describe("assistantHost.start and the lane's conversation (#12365)", () => {
  beforeEach(() => {
    start.mockClear();
  });

  it("continues the conversation unless the renderer asks for a new one", async () => {
    await handler(context({ id: 42 }), PAYLOAD);
    await handler(context({ id: 42 }), { ...PAYLOAD, fresh: true });
    // Only a real `true` declines it. A malformed flag keeps the conversation rather than
    // throwing it away.
    await handler(context({ id: 42 }), { ...PAYLOAD, fresh: "yes" });

    expect(start.mock.calls.map(([opts]) => opts.fresh)).toEqual([false, true, false]);
  });

  it("never lets the renderer name the conversation to continue", async () => {
    await handler(context({ id: 42 }), { ...PAYLOAD, resumeSessionId: "ses_someone_else" });
    expect(start.mock.calls[0]![0]).not.toHaveProperty("resumeSessionId");
  });

  it("lets only the workspace's own view keep that workspace's conversation", async () => {
    await handler(context({ id: 42 }, "p1"), PAYLOAD);
    await handler(context({ id: 42 }, "p2"), PAYLOAD);
    // Still coming up: not bound yet, and known only by the startup URL it was loaded with.
    await handler(context({ id: 42 }, null, STARTUP_URL), PAYLOAD);
    await handler(context({ id: 42 }, null), PAYLOAD);

    // Every one of them still starts — a foreign view always could — but only the owners
    // may continue, discard or overwrite the conversation.
    expect(start.mock.calls.map(([opts]) => opts.recordable)).toEqual([true, false, true, false]);
  });
});

describe("assistantHost resume records belong to one workspace (#12365)", () => {
  beforeEach(() => {
    listResumable.mockClear();
    discardResume.mockClear();
  });

  it("lists only the calling view's own workspace", async () => {
    expect(await listHandler(context({ id: 42 }, "p1"), "p1")).toEqual([
      { slot: 1, panelWasOpen: true },
    ]);
    expect(await listHandler(context({ id: 42 }, "p1"), "p2")).toEqual([]);
    expect(await listHandler(context({ id: 42 }, null), "p1")).toEqual([]);
    expect(listResumable.mock.calls).toEqual([["p1"]]);
  });

  it("answers a view still coming up by its startup URL, and a bound view by its binding", async () => {
    // A panel coming back cold asks before main has registered its view. Refused there,
    // every restored conversation would stay behind.
    expect(await listHandler(context({ id: 42 }, null, STARTUP_URL), "p1")).toEqual([
      { slot: 1, panelWasOpen: true },
    ]);
    expect(await listHandler(context({ id: 42 }, null, STARTUP_URL), "p2")).toEqual([]);
    // Once bound, the binding is the answer: a stale query string never overrides it.
    expect(await listHandler(context({ id: 42 }, "p2", STARTUP_URL), "p1")).toEqual([]);
  });

  it("discards only its own workspace's lanes, and only a lane that exists", async () => {
    expect(await discardHandler(context({ id: 42 }, "p1"), "p1", 2)).toEqual({ discarded: true });
    expect(await discardHandler(context({ id: 42 }, "p1"), "p2", 0)).toEqual({
      discarded: false,
    });
    // Resolved down to lane 0 the way a start's slot is, this would throw away a
    // conversation the caller never named.
    expect(await discardHandler(context({ id: 42 }, "p1"), "p1", 9)).toEqual({
      discarded: false,
    });
    // The asking surface comes from the context, so main can tell it from the others
    // still watching the lane.
    expect(discardResume.mock.calls).toEqual([["p1", 2, 7]]);
  });

  it("reports a discard main refused", async () => {
    discardResume.mockResolvedValueOnce(false);
    expect(await discardHandler(context({ id: 42 }, "p1"), "p1", 0)).toEqual({
      discarded: false,
    });
  });
});
