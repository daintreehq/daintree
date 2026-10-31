import { describe, expect, it, vi } from "vitest";
import { RecentTerminalExits, exitMatches } from "../RecentTerminalExits.js";

describe("RecentTerminalExits (#15728)", () => {
  it("finds an incarnation's exit by generation, not another one under the same id", () => {
    const exits = new RecentTerminalExits();
    exits.record({ terminalId: "t1", launchGeneration: 1, exitCode: 0, signal: undefined });
    exits.record({ terminalId: "t1", launchGeneration: 2, exitCode: 137, signal: 9 });

    expect(exits.find("t1", 1)?.exitCode).toBe(0);
    expect(exits.find("t1", 2)?.signal).toBe(9);
    expect(exits.find("t1", 3)).toBeUndefined();
  });

  it("answers nothing to a caller that can't name the incarnation, and keeps no exit without one", () => {
    const exits = new RecentTerminalExits();
    const listener = vi.fn();
    exits.onExit(listener);
    exits.record({ terminalId: "t1", launchGeneration: 1, exitCode: 0, signal: undefined });
    exits.record({ terminalId: "t2", launchGeneration: undefined, exitCode: 1, signal: undefined });

    expect(exits.find("t1", undefined)).toBeUndefined();
    expect(exits.find("t2", 1)).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("names the incarnation whose exit it saw last under an id", () => {
    const exits = new RecentTerminalExits();
    exits.record({ terminalId: "t1", launchGeneration: 1, exitCode: 0, signal: undefined });
    exits.record({ terminalId: "t2", launchGeneration: 7, exitCode: 0, signal: undefined });
    exits.record({ terminalId: "t1", launchGeneration: 3, exitCode: 0, signal: undefined });

    expect(exits.latestGeneration("t1")).toBe(3);
    expect(exits.latestGeneration("t3")).toBeUndefined();
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

  it("keeps telling one listener after another unsubscribes, past one that throws", () => {
    const exits = new RecentTerminalExits();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    exits.onExit(() => {
      throw new Error("boom");
    });
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = exits.onExit((exit) => first.push(exit.terminalId));
    exits.onExit((exit) => second.push(exit.terminalId));

    exits.record({ terminalId: "a", launchGeneration: 1, exitCode: 0, signal: undefined });
    stopFirst();
    exits.record({ terminalId: "b", launchGeneration: 1, exitCode: 0, signal: undefined });

    expect(first).toEqual(["a"]);
    expect(second).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("matches only the asked incarnation, and never a caller that holds none", () => {
    const exit = {
      terminalId: "t1",
      launchGeneration: 2,
      exitCode: 0,
      signal: undefined,
      observedAt: 0,
    };
    expect(exitMatches(exit, "t1", 2)).toBe(true);
    expect(exitMatches(exit, "t1", 1)).toBe(false);
    expect(exitMatches(exit, "t1", undefined)).toBe(false);
    expect(exitMatches(exit, "t2", 2)).toBe(false);
  });
});
