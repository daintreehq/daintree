import { describe, expect, it, vi } from "vitest";
import { readClosedPanelProcess, withClosedPanelProcesses } from "../closedPanelProcesses.js";

describe("readClosedPanelProcess (#14474)", () => {
  it("reports a trashed process still running with the host's own deadline", async () => {
    const observed = await readClosedPanelProcess("t1", async () => ({
      isExited: false,
      isTrashed: true,
      trashExpiresAt: 42_000,
    }));
    expect(observed).toEqual({ terminalId: "t1", exited: false, trashExpiresAt: 42_000 });
  });

  it("reports an exit the host saw", async () => {
    const observed = await readClosedPanelProcess("t1", async () => ({
      isExited: true,
      isTrashed: true,
      trashExpiresAt: 42_000,
    }));
    expect(observed.exited).toBe(true);
  });

  it("gives no deadline for a record the trash doesn't hold yet", async () => {
    const observed = await readClosedPanelProcess("t1", async () => ({
      isExited: false,
      isTrashed: false,
      trashExpiresAt: 42_000,
    }));
    expect(observed).toEqual({ terminalId: "t1", exited: false, trashExpiresAt: null });
  });

  it.each([
    ["no record", async () => null],
    [
      "a failed read",
      async () => {
        throw new Error("timeout");
      },
    ],
    ["an older host without the field", async () => ({ isTrashed: true })],
  ])("never takes %s as an exit", async (_label, readRecord) => {
    const observed = await readClosedPanelProcess("t1", readRecord);
    expect(observed).toEqual({ terminalId: "t1", exited: null, trashExpiresAt: null });
  });
});

describe("withClosedPanelProcesses (#14474)", () => {
  const read = vi.fn(async (terminalId: string) => ({
    terminalId,
    exited: false,
    trashExpiresAt: null,
  }));

  it("adds one observation per closed id, in order, keeping the rest of the answer", async () => {
    const result = await withClosedPanelProcesses(
      { ok: true, result: { closedIds: ["a", "b"], extra: 1 } },
      read
    );
    expect(result).toEqual({
      ok: true,
      result: {
        closedIds: ["a", "b"],
        extra: 1,
        processes: [
          { terminalId: "a", exited: false, trashExpiresAt: null },
          { terminalId: "b", exited: false, trashExpiresAt: null },
        ],
      },
    });
  });

  it("passes failures and answers without closedIds through untouched", async () => {
    read.mockClear();
    const failed = { ok: false as const, error: { code: "NOT_FOUND" as const, message: "x" } };
    expect(await withClosedPanelProcesses(failed, read)).toBe(failed);
    for (const answer of [null, {}, { closedIds: "t1" }]) {
      const odd = { ok: true as const, result: answer };
      expect(await withClosedPanelProcesses(odd, read)).toBe(odd);
    }
    expect(read).not.toHaveBeenCalled();
  });
});
