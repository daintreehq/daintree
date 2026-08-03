import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TerminalReconnectResult } from "@shared/types/ipc/terminal";

const reconnectMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  terminalClient: {
    reconnect: (terminalId: string) => reconnectMock(terminalId),
  },
}));

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
}));

const { reconnectWithTimeout } = await import("../reconnectManager");

const noopLog = () => {};

beforeEach(() => {
  reconnectMock.mockReset();
});

describe("reconnectWithTimeout", () => {
  it("consumes a prefetched live result without firing the per-panel IPC", async () => {
    const prefetched: TerminalReconnectResult = {
      exists: true,
      id: "t-1",
      hasPty: true,
    } as TerminalReconnectResult;

    const outcome = await reconnectWithTimeout("t-1", noopLog, prefetched);

    expect(outcome).toEqual({ status: "found", terminal: prefetched });
    expect(reconnectMock).not.toHaveBeenCalled();
  });

  it("maps a prefetched { exists: false } to not_found without IPC", async () => {
    const outcome = await reconnectWithTimeout("t-gone", noopLog, {
      exists: false,
    } as TerminalReconnectResult);

    expect(outcome).toEqual({ status: "not_found" });
    expect(reconnectMock).not.toHaveBeenCalled();
  });

  it("maps a prefetched ptyless terminal to not_found, mirroring the IPC path", async () => {
    const outcome = await reconnectWithTimeout("t-noPty", noopLog, {
      exists: true,
      id: "t-noPty",
      hasPty: false,
    } as TerminalReconnectResult);

    expect(outcome).toEqual({ status: "not_found" });
    expect(reconnectMock).not.toHaveBeenCalled();
  });

  // #11652: a refused reconnect means the id is still LIVE under another
  // workspace. Collapsing it into not_found would let restore respawn onto that
  // id and re-place the owner's PTY, so it has to stay distinguishable.
  it("maps a prefetched ownership refusal to conflict, not not_found", async () => {
    const outcome = await reconnectWithTimeout("t-foreign", noopLog, {
      exists: false,
      conflict: true,
    } as TerminalReconnectResult);

    expect(outcome).toEqual({ status: "conflict" });
    expect(reconnectMock).not.toHaveBeenCalled();
  });

  it("maps an ownership refusal to conflict on the fallback path too", async () => {
    reconnectMock.mockResolvedValueOnce({ exists: false, conflict: true });

    const outcome = await reconnectWithTimeout("t-foreign", noopLog);

    expect(outcome).toEqual({ status: "conflict" });
  });

  it("falls back to the per-panel IPC when no prefetched result is supplied", async () => {
    reconnectMock.mockResolvedValueOnce({ exists: true, id: "t-2", hasPty: true });

    const outcome = await reconnectWithTimeout("t-2", noopLog);

    expect(outcome.status).toBe("found");
    expect(reconnectMock).toHaveBeenCalledTimes(1);
    expect(reconnectMock).toHaveBeenCalledWith("t-2");
  });

  it("reports IPC errors as error outcomes on the fallback path", async () => {
    const failure = new Error("ipc down");
    reconnectMock.mockRejectedValueOnce(failure);

    const outcome = await reconnectWithTimeout("t-3", noopLog);

    expect(outcome).toEqual({ status: "error", error: failure });
  });

  it("times out a hung IPC probe on the fallback path", async () => {
    vi.useFakeTimers();
    try {
      reconnectMock.mockReturnValueOnce(new Promise(() => {}));

      const outcomePromise = reconnectWithTimeout("t-hung", noopLog);
      await vi.advanceTimersByTimeAsync(2001);

      await expect(outcomePromise).resolves.toEqual({ status: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
