import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { RemoteHostManager } from "../RemoteHostManager.js";
import { observeForwardedInvokes, RemoteRouterImpl } from "../RemoteRouter.js";
import { WindowHostBinding } from "../WindowHostBinding.js";

const continuation = { pendingEscapeTail: "\x1b[3", streamOffset: 42 };
const snapshot = { data: "S", cols: 80, rows: 24 };

function routerAnswering(data: unknown) {
  const answer = { __daintreeIpcEnvelope: true, ok: true, data };
  const manager = {
    get: () => ({ invoke: vi.fn(async () => answer) }),
  } as unknown as RemoteHostManager;
  const router = new RemoteRouterImpl(manager, new WindowHostBinding(), {
    projectKeyFor: () => "studio-01:proj",
    windowIdFor: () => null,
  });
  return { router, answer };
}

async function forward(channel: string, data: unknown): Promise<unknown> {
  const { router } = routerAnswering(data);
  const envelope = await router.forwardInvoke("studio-01", 9, channel, ["t1"]);
  if (!envelope.ok) throw new Error("expected a successful envelope");
  return envelope.data;
}

describe("forwarded snapshot reads", () => {
  it("keeps the continuation of a snapshot the host vouched for, without the voucher", async () => {
    await expect(
      forward(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, {
        ...snapshot,
        continuation,
        remoteStreamOffsets: true,
      })
    ).resolves.toEqual({ ...snapshot, continuation });
  });

  it("drops the continuation of a snapshot from a host that does not forward stream offsets", async () => {
    // What every host since #12791 answers, whether or not its stream carries offsets.
    await expect(
      forward(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, { ...snapshot, continuation })
    ).resolves.toEqual(snapshot);
  });

  it("drops a vouched-for continuation that is malformed", async () => {
    await expect(
      forward(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, {
        ...snapshot,
        continuation: { pendingEscapeTail: "\x1b[", streamOffset: 1.5 },
        remoteStreamOffsets: true,
      })
    ).resolves.toEqual(snapshot);
  });

  it("guards every entry of a batch read and leaves nulls alone", async () => {
    await expect(
      forward(CHANNELS.TERMINAL_GET_SERIALIZED_STATES, {
        vouched: { ...snapshot, continuation, remoteStreamOffsets: true },
        unvouched: { ...snapshot, continuation },
        gone: null,
      })
    ).resolves.toEqual({
      vouched: { ...snapshot, continuation },
      unvouched: snapshot,
      gone: null,
    });
  });

  it("passes a null snapshot, other channels, and refusals through untouched", async () => {
    await expect(forward(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, null)).resolves.toBeNull();
    const other = { ...snapshot, continuation };
    await expect(forward("terminal:get-info", other)).resolves.toBe(other);

    const refusal = { __daintreeIpcEnvelope: true, ok: false, error: { message: "refused" } };
    const manager = {
      get: () => ({ invoke: vi.fn(async () => refusal) }),
    } as unknown as RemoteHostManager;
    const router = new RemoteRouterImpl(manager, new WindowHostBinding(), {
      projectKeyFor: () => "studio-01:proj",
      windowIdFor: () => null,
    });
    await expect(
      router.forwardInvoke("studio-01", 9, CHANNELS.TERMINAL_GET_SERIALIZED_STATE, ["t1"])
    ).resolves.toBe(refusal);
  });

  it("guards the answer whether or not anyone observes forwarded calls", async () => {
    const stop = observeForwardedInvokes(() => {});
    try {
      await expect(
        forward(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, { ...snapshot, continuation })
      ).resolves.toEqual(snapshot);
    } finally {
      stop();
    }
  });

  it("never mutates the host's answer", async () => {
    const data = { ...snapshot, continuation, remoteStreamOffsets: true };
    const { router, answer } = routerAnswering(data);
    await router.forwardInvoke("studio-01", 9, CHANNELS.TERMINAL_GET_SERIALIZED_STATE, ["t1"]);
    expect(answer.data).toEqual({ ...snapshot, continuation, remoteStreamOffsets: true });
  });
});
