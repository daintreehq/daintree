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
const discardResume = vi.fn(async (_projectId: string, _slot: number) => undefined);

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

function context(senderWindow: { id: number } | null, projectId: string | null = "p1"): IpcContext {
  return { webContentsId: 7, senderWindow, projectId } as unknown as IpcContext;
}

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
    expect(discardResume.mock.calls).toEqual([["p1", 2]]);
  });
});
