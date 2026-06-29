import { describe, expect, it } from "vitest";
import { TerminalRegistry } from "../TerminalRegistry.js";
import { PRESERVED_SNAPSHOT_RECENT_ACCESS_GUARD_MS, type TerminalInfo } from "../types.js";
import type { TerminalProcess } from "../TerminalProcess.js";

const NOW = 1_000_000_000_000;

function createPreservedTerminal(options: {
  id: string;
  preservedAt?: number;
  lastAccessedAt?: number;
  preserved?: boolean;
}): TerminalProcess {
  const info = {
    id: options.id,
    preservedSnapshot: options.preserved === false ? undefined : `snapshot-${options.id}`,
    preservedAt: options.preservedAt,
    preservedSnapshotLastAccessedAt: options.lastAccessedAt,
  } as unknown as TerminalInfo;

  return {
    getInfo: () => info,
  } as unknown as TerminalProcess;
}

describe("TerminalRegistry.evictPreservedSnapshots", () => {
  it("evicts nothing when the count is at or below the cap", () => {
    const registry = new TerminalRegistry();
    for (let i = 0; i < 3; i++) {
      registry.add(`t${i}`, createPreservedTerminal({ id: `t${i}`, preservedAt: NOW + i }));
    }

    registry.evictPreservedSnapshots(3, undefined, NOW + 1000);

    expect(registry.size()).toBe(3);
  });

  it("evicts the oldest snapshot when one over the cap", () => {
    const registry = new TerminalRegistry();
    registry.add("old", createPreservedTerminal({ id: "old", preservedAt: NOW - 100 }));
    registry.add("mid", createPreservedTerminal({ id: "mid", preservedAt: NOW - 50 }));
    registry.add("new", createPreservedTerminal({ id: "new", preservedAt: NOW }));

    registry.evictPreservedSnapshots(2, undefined, NOW + 1_000_000);

    expect(registry.has("old")).toBe(false);
    expect(registry.has("mid")).toBe(true);
    expect(registry.has("new")).toBe(true);
  });

  it("never evicts skipId even when it is the oldest, but still evicts other candidates", () => {
    const registry = new TerminalRegistry();
    // skipId mimics a just-exited terminal whose preservedAt isn't written yet,
    // so it sorts oldest (preservedAt undefined → 0).
    registry.add("exiting", createPreservedTerminal({ id: "exiting" }));
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 100 }));
    registry.add("b", createPreservedTerminal({ id: "b", preservedAt: NOW - 50 }));

    // Cap of 1 over 3 entries → candidates are the two oldest ("exiting", "a").
    // "exiting" is skipId so it survives; "a" is evicted.
    registry.evictPreservedSnapshots(1, "exiting", NOW + 1_000_000);

    expect(registry.has("exiting")).toBe(true);
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
  });

  it("skips a recently-accessed snapshot and tolerates over-cap", () => {
    const registry = new TerminalRegistry();
    // Oldest by preservedAt, but accessed within the guard window.
    registry.add(
      "viewed",
      createPreservedTerminal({
        id: "viewed",
        preservedAt: NOW - 1000,
        lastAccessedAt: NOW,
      })
    );
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 500 }));
    registry.add("b", createPreservedTerminal({ id: "b", preservedAt: NOW - 200 }));

    // Cap of 1: candidates are the two oldest ("viewed", "a"). "viewed" is
    // guarded, so only "a" is evicted; the registry stays over-cap at 2.
    registry.evictPreservedSnapshots(1, undefined, NOW);

    expect(registry.has("viewed")).toBe(true);
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
    expect(registry.size()).toBe(2);
  });

  it("treats a snapshot accessed just outside the guard window as evictable", () => {
    const registry = new TerminalRegistry();
    registry.add(
      "stale",
      createPreservedTerminal({
        id: "stale",
        preservedAt: NOW - 1000,
        lastAccessedAt: NOW - PRESERVED_SNAPSHOT_RECENT_ACCESS_GUARD_MS - 1,
      })
    );
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW }));

    registry.evictPreservedSnapshots(1, undefined, NOW);

    expect(registry.has("stale")).toBe(false);
    expect(registry.has("a")).toBe(true);
  });

  it("ignores terminals without a preserved snapshot", () => {
    const registry = new TerminalRegistry();
    registry.add("live1", createPreservedTerminal({ id: "live1", preserved: false }));
    registry.add("live2", createPreservedTerminal({ id: "live2", preserved: false }));
    registry.add("p1", createPreservedTerminal({ id: "p1", preservedAt: NOW - 100 }));
    registry.add("p2", createPreservedTerminal({ id: "p2", preservedAt: NOW }));

    // Cap of 1 over 2 preserved entries → evict the oldest preserved only; live
    // terminals are untouched.
    registry.evictPreservedSnapshots(1, undefined, NOW + 1_000_000);

    expect(registry.has("p1")).toBe(false);
    expect(registry.has("p2")).toBe(true);
    expect(registry.has("live1")).toBe(true);
    expect(registry.has("live2")).toBe(true);
  });

  it("does not evict when all over-cap candidates are guarded", () => {
    const registry = new TerminalRegistry();
    registry.add(
      "g1",
      createPreservedTerminal({ id: "g1", preservedAt: NOW - 100, lastAccessedAt: NOW })
    );
    registry.add(
      "g2",
      createPreservedTerminal({ id: "g2", preservedAt: NOW - 50, lastAccessedAt: NOW })
    );
    registry.add("keep", createPreservedTerminal({ id: "keep", preservedAt: NOW }));

    registry.evictPreservedSnapshots(1, undefined, NOW);

    expect(registry.size()).toBe(3);
  });

  it("sorts a snapshot with no preservedAt as oldest", () => {
    const registry = new TerminalRegistry();
    registry.add("noTimestamp", createPreservedTerminal({ id: "noTimestamp" }));
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 100 }));

    registry.evictPreservedSnapshots(1, undefined, NOW + 1_000_000);

    expect(registry.has("noTimestamp")).toBe(false);
    expect(registry.has("a")).toBe(true);
  });
});
