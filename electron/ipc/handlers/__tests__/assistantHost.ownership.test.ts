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

vi.mock("../../../services/assistant-host/AssistantHostService.js", () => ({
  assistantHostService: {
    start,
    send: vi.fn(),
    stop: vi.fn(),
    isOwnedBy: vi.fn(() => true),
  },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: () => undefined },
}));

const { assistantHostNamespace } = await import("../assistantHost.js");

const handler = assistantHostNamespace.ops.start.handler as (
  ctx: IpcContext,
  payload: unknown
) => Promise<unknown>;

function context(senderWindow: { id: number } | null): IpcContext {
  return { webContentsId: 7, senderWindow } as unknown as IpcContext;
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
