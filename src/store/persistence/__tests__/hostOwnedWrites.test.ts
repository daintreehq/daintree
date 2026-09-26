import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logDebugMock, logErrorMock } = vi.hoisted(() => ({
  logDebugMock: vi.fn(),
  logErrorMock: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  logDebug: logDebugMock,
  logError: logErrorMock,
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  _resetHostOwnedWritesForTesting,
  dropDeferredHostOwnedWrites,
  flushDeferredHostOwnedWrites,
  hasDeferredHostOwnedWrite,
  sendHostOwnedWrite,
  setHostOwnedWriteFlushBarrier,
} from "../hostOwnedWrites";
import {
  _resetTerminalInputGateForTesting,
  setHostInputBlock,
  setLeaseInputBlock,
} from "@/services/terminal/inputGate";

const appError = (code: string) => new Error(`[AppError|${code}] refused`);

const disconnected = () => setHostInputBlock({ kind: "disconnected", hostName: "studio" });
const drivenElsewhere = () =>
  setLeaseInputBlock({ kind: "driven-elsewhere", driverName: "laptop", projectId: "proj-1" });

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  _resetTerminalInputGateForTesting();
  _resetHostOwnedWritesForTesting();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetHostOwnedWritesForTesting();
  _resetTerminalInputGateForTesting();
});

describe("sendHostOwnedWrite", () => {
  it("sends straight through, and throws a real failure to the caller, with no block (local view)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await expect(sendHostOwnedWrite("k", send, vi.fn())).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);

    const failure = new Error("EACCES: permission denied");
    await expect(sendHostOwnedWrite("k", () => Promise.reject(failure), vi.fn())).rejects.toBe(
      failure
    );
    expect(hasDeferredHostOwnedWrite("k")).toBe(false);
  });

  it("doesn't send at all while another screen drives the project", async () => {
    drivenElsewhere();
    const send = vi.fn().mockResolvedValue(undefined);
    await expect(sendHostOwnedWrite("k", send, vi.fn())).resolves.toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("k")).toBe(false);
  });

  it("treats a DRIVEN_ELSEWHERE refusal as expected: skipped, never thrown or logged as an error", async () => {
    const outcome = await sendHostOwnedWrite(
      "k",
      () => Promise.reject(appError("DRIVEN_ELSEWHERE")),
      vi.fn()
    );
    expect(outcome).toBe("skipped");
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(logDebugMock).toHaveBeenCalled();
  });

  it("holds the latest write per key while the link is down and replays it once it is back", async () => {
    disconnected();
    const first = vi.fn();
    const second = vi.fn();
    const send = vi.fn();
    expect(await sendHostOwnedWrite("k", send, first)).toBe("deferred");
    expect(await sendHostOwnedWrite("k", send, second)).toBe("deferred");
    expect(send).not.toHaveBeenCalled();

    setHostInputBlock(null);
    await settle();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("waits for the flush barrier (lease refresh, fresh-session rehydrate) before replaying", async () => {
    let release!: () => void;
    const barrier = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    setHostOwnedWriteFlushBarrier(barrier);
    disconnected();
    const replay = vi.fn();
    await sendHostOwnedWrite("k", vi.fn(), replay);

    setHostInputBlock(null);
    await settle();
    expect(barrier).toHaveBeenCalledTimes(1);
    expect(replay).not.toHaveBeenCalled();

    release();
    await settle();
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("drops what it held once another screen takes the project over", async () => {
    disconnected();
    const replay = vi.fn();
    await sendHostOwnedWrite("k", vi.fn(), replay);

    drivenElsewhere();
    setHostInputBlock(null);
    await settle();
    flushDeferredHostOwnedWrites();
    expect(replay).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("k")).toBe(false);
  });

  it("a takeover learned only after reconnecting (the lease refresh) still drops the held write", async () => {
    setHostOwnedWriteFlushBarrier(async () => drivenElsewhere());
    disconnected();
    const replay = vi.fn();
    await sendHostOwnedWrite("k", vi.fn(), replay);

    setHostInputBlock(null);
    await settle();
    expect(replay).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("k")).toBe(false);
  });

  it("holds a write the link lost on its way (HOST_DISCONNECTED / OUTCOME_UNKNOWN) without logging an error", async () => {
    disconnected();
    setHostInputBlock(null);
    const replay = vi.fn();
    // The gate looks open, but the link died under the request.
    const barrier = vi.fn(async () => {});
    barrier.mockImplementationOnce(async () => disconnected());
    setHostOwnedWriteFlushBarrier(barrier);
    const outcome = await sendHostOwnedWrite(
      "k",
      () => Promise.reject(appError("HOST_DISCONNECTED")),
      replay
    );
    expect(outcome).toBe("deferred");
    expect(logErrorMock).not.toHaveBeenCalled();
    await settle();
    expect(replay).not.toHaveBeenCalled();
    expect(hasDeferredHostOwnedWrite("k")).toBe(true);

    setHostInputBlock(null);
    await settle();
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("can't loop when the host keeps answering disconnected while the gate stays open", async () => {
    let sends = 0;
    const attempt = (): Promise<unknown> =>
      sendHostOwnedWrite(
        "k",
        () => {
          sends += 1;
          return Promise.reject(appError("OUTCOME_UNKNOWN"));
        },
        () => void attempt()
      );
    await attempt();
    await settle();
    await settle();
    // The first send, then at most one replay before a gate change rearms it.
    expect(sends).toBe(2);
    expect(hasDeferredHostOwnedWrite("k")).toBe(true);
  });

  it("a newer call supersedes a held one, so a lost older write can't overwrite a newer one", async () => {
    let rejectOld!: (error: Error) => void;
    const oldReplay = vi.fn();
    const pending = sendHostOwnedWrite(
      "k",
      () => new Promise((_, reject) => (rejectOld = reject)),
      oldReplay
    );
    await settle();
    await expect(
      sendHostOwnedWrite("k", vi.fn().mockResolvedValue(undefined), vi.fn())
    ).resolves.toBe("sent");
    rejectOld(appError("HOST_DISCONNECTED"));
    await pending;
    expect(hasDeferredHostOwnedWrite("k")).toBe(false);
    flushDeferredHostOwnedWrites();
    expect(oldReplay).not.toHaveBeenCalled();
  });

  it("holds while a remote view doesn't know yet who drives, and replays once it does", async () => {
    setLeaseInputBlock({ kind: "lease-unknown", hostName: "studio" });
    const send = vi.fn();
    const replay = vi.fn();
    expect(await sendHostOwnedWrite("k", send, replay)).toBe("deferred");
    setLeaseInputBlock(null);
    await settle();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("never holds a write that was in flight when everything held was dropped (a takeover)", async () => {
    let lose!: (error: Error) => void;
    const replay = vi.fn();
    const pending = sendHostOwnedWrite(
      "k",
      () => new Promise((_, reject) => (lose = reject)),
      replay
    );
    await settle();
    dropDeferredHostOwnedWrites("this view took the project over");
    disconnected();
    lose(appError("HOST_DISCONNECTED"));
    await expect(pending).resolves.toBe("deferred");
    expect(hasDeferredHostOwnedWrite("k")).toBe(false);
    setHostInputBlock(null);
    await settle();
    expect(replay).not.toHaveBeenCalled();
  });
});
