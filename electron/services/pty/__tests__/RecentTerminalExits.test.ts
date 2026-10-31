import { describe, expect, it, vi } from "vitest";
import { RecentTerminalExits, exitMatches } from "../RecentTerminalExits.js";

describe("RecentTerminalExits (#15728)", () => {
  it("finds an incarnation's exit by generation, not a later one under the same id", () => {
    const exits = new RecentTerminalExits();
    exits.record({ terminalId: "t1", launchGeneration: 1, exitCode: 0, signal: undefined });
    exits.record({ terminalId: "t1", launchGeneration: 2, exitCode: 137, signal: 9 });

    expect(exits.find("t1", 1)?.exitCode).toBe(0);
    expect(exits.find("t1", 2)?.signal).toBe(9);
    expect(exits.find("t1", 3)).toBeUndefined();
    expect(exits.find("t1")?.launchGeneration).toBe(2);
  });

  it("matches an exit the host sent without a generation to whichever one the caller holds", () => {
    const exits = new RecentTerminalExits();
    exits.record({ terminalId: "t1", launchGeneration: undefined, exitCode: 1, signal: undefined });

    expect(exits.find("t1", 5)?.exitCode).toBe(1);
  });

  it("forgets exits older than its window", () => {
    let now = 1_000;
    const exits = new RecentTerminalExits(() => now, 60_000);
    exits.record({ terminalId: "old", launchGeneration: 1, exitCode: 0, signal: undefined });
    now += 30_000;
    exits.record({ terminalId: "new", launchGeneration: 1, exitCode: 0, signal: undefined });
    now += 30_000;

    expect(exits.find("old", 1)).toBeUndefined();
    expect(exits.find("new", 1)).toBeDefined();
  });

  it("drops the oldest exits past its size bound", () => {
    const exits = new RecentTerminalExits(Date.now, 60_000, 2);
    for (const id of ["a", "b", "c"]) {
      exits.record({ terminalId: id, launchGeneration: 1, exitCode: 0, signal: undefined });
    }

    expect(exits.find("a", 1)).toBeUndefined();
    expect(exits.find("b", 1)).toBeDefined();
    expect(exits.find("c", 1)).toBeDefined();
  });

  it("tells each listener of an exit until it unsubscribes, past one that throws", () => {
    const exits = new RecentTerminalExits();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const thrower = exits.onExit(() => {
      throw new Error("boom");
    });
    const seen: string[] = [];
    const stop = exits.onExit((exit) => seen.push(exit.terminalId));

    exits.record({ terminalId: "a", launchGeneration: 1, exitCode: 0, signal: undefined });
    stop();
    thrower();
    exits.record({ terminalId: "b", launchGeneration: 1, exitCode: 0, signal: undefined });

    expect(seen).toEqual(["a"]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("matches only the asked incarnation when both sides know theirs", () => {
    const exit = {
      terminalId: "t1",
      launchGeneration: 2,
      exitCode: 0,
      signal: undefined,
      observedAt: 0,
    };
    expect(exitMatches(exit, "t1", 2)).toBe(true);
    expect(exitMatches(exit, "t1", 1)).toBe(false);
    expect(exitMatches(exit, "t1", undefined)).toBe(true);
    expect(exitMatches(exit, "t2", 2)).toBe(false);
  });
});
