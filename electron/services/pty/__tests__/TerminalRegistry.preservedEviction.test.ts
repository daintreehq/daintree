import { describe, expect, it } from "vitest";
import { TerminalRegistry } from "../TerminalRegistry.js";
import {
  MAX_PRESERVED_TERMINAL_SNAPSHOTS,
  PRESERVED_SNAPSHOT_RECENT_ACCESS_GUARD_MS,
  type TerminalInfo,
} from "../types.js";
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

  it("enforces the default cap, evicting exactly the oldest overflow", () => {
    const registry = new TerminalRegistry();
    // One over the production cap; the oldest must be the single eviction.
    for (let i = 0; i <= MAX_PRESERVED_TERMINAL_SNAPSHOTS; i++) {
      registry.add(`t${i}`, createPreservedTerminal({ id: `t${i}`, preservedAt: NOW + i }));
    }

    registry.evictPreservedSnapshots(undefined, undefined, NOW + 10_000_000);

    expect(registry.size()).toBe(MAX_PRESERVED_TERMINAL_SNAPSHOTS);
    expect(registry.has("t0")).toBe(false); // oldest
    expect(registry.has(`t${MAX_PRESERVED_TERMINAL_SNAPSHOTS}`)).toBe(true); // newest
  });

  it("keeps skipId (the just-preserved newest entry) and evicts the oldest instead", () => {
    const registry = new TerminalRegistry();
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 100 }));
    registry.add("b", createPreservedTerminal({ id: "b", preservedAt: NOW - 50 }));
    // skipId mirrors the real flow: the freshly-captured (newest) terminal.
    registry.add("fresh", createPreservedTerminal({ id: "fresh", preservedAt: NOW }));

    registry.evictPreservedSnapshots(2, "fresh", NOW + 1_000_000);

    expect(registry.has("fresh")).toBe(true);
    expect(registry.has("a")).toBe(false); // oldest evicted
    expect(registry.has("b")).toBe(true);
  });

  it("never evicts skipId even if it is the oldest, evicting the next candidate instead", () => {
    const registry = new TerminalRegistry();
    registry.add("oldSkip", createPreservedTerminal({ id: "oldSkip", preservedAt: NOW - 100 }));
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 50 }));
    registry.add("b", createPreservedTerminal({ id: "b", preservedAt: NOW }));

    registry.evictPreservedSnapshots(2, "oldSkip", NOW + 1_000_000);

    expect(registry.has("oldSkip")).toBe(true);
    expect(registry.has("a")).toBe(false); // next-oldest non-skipped
    expect(registry.has("b")).toBe(true);
  });

  it("skips a recently-accessed snapshot and evicts the next-oldest evictable one", () => {
    const registry = new TerminalRegistry();
    // Oldest by preservedAt, but accessed within the guard window → kept.
    registry.add(
      "viewed",
      createPreservedTerminal({ id: "viewed", preservedAt: NOW - 1000, lastAccessedAt: NOW })
    );
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 500 }));
    registry.add("b", createPreservedTerminal({ id: "b", preservedAt: NOW - 200 }));

    // Cap of 2 over 3 entries → evict 1. "viewed" is guarded, so "a" goes.
    registry.evictPreservedSnapshots(2, undefined, NOW);

    expect(registry.has("viewed")).toBe(true);
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
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
    // terminals are never counted or touched.
    registry.evictPreservedSnapshots(1, undefined, NOW + 1_000_000);

    expect(registry.has("p1")).toBe(false);
    expect(registry.has("p2")).toBe(true);
    expect(registry.has("live1")).toBe(true);
    expect(registry.has("live2")).toBe(true);
  });

  it("tolerates over-cap when every entry is being actively viewed", () => {
    const registry = new TerminalRegistry();
    // All entries are within the access guard, so none is a valid eviction
    // target — the cap yields to not dropping a snapshot the user is viewing.
    registry.add(
      "g1",
      createPreservedTerminal({ id: "g1", preservedAt: NOW - 100, lastAccessedAt: NOW })
    );
    registry.add(
      "g2",
      createPreservedTerminal({ id: "g2", preservedAt: NOW - 50, lastAccessedAt: NOW })
    );
    registry.add(
      "g3",
      createPreservedTerminal({ id: "g3", preservedAt: NOW, lastAccessedAt: NOW })
    );

    registry.evictPreservedSnapshots(1, undefined, NOW);

    expect(registry.size()).toBe(3);
  });

  it("evicts an unviewed newest entry rather than a viewed older one", () => {
    const registry = new TerminalRegistry();
    // Older entries are actively viewed; the newest has never been served.
    registry.add(
      "viewedOld",
      createPreservedTerminal({ id: "viewedOld", preservedAt: NOW - 100, lastAccessedAt: NOW })
    );
    registry.add(
      "viewedMid",
      createPreservedTerminal({ id: "viewedMid", preservedAt: NOW - 50, lastAccessedAt: NOW })
    );
    registry.add(
      "freshUnviewed",
      createPreservedTerminal({ id: "freshUnviewed", preservedAt: NOW })
    );

    // Cap 2 over 3 → evict 1. The viewed entries are guarded, so the unviewed
    // newest is the only valid target.
    registry.evictPreservedSnapshots(2, undefined, NOW);

    expect(registry.has("freshUnviewed")).toBe(false);
    expect(registry.has("viewedOld")).toBe(true);
    expect(registry.has("viewedMid")).toBe(true);
  });

  it("sorts a snapshot with no preservedAt as oldest", () => {
    const registry = new TerminalRegistry();
    registry.add("noTimestamp", createPreservedTerminal({ id: "noTimestamp" }));
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 100 }));

    registry.evictPreservedSnapshots(1, undefined, NOW + 1_000_000);

    expect(registry.has("noTimestamp")).toBe(false);
    expect(registry.has("a")).toBe(true);
  });

  it("evicts all unguarded entries when called with max 0", () => {
    const registry = new TerminalRegistry();
    registry.add("a", createPreservedTerminal({ id: "a", preservedAt: NOW - 100 }));
    registry.add(
      "viewed",
      createPreservedTerminal({ id: "viewed", preservedAt: NOW - 50, lastAccessedAt: NOW })
    );
    registry.add("b", createPreservedTerminal({ id: "b", preservedAt: NOW }));

    registry.evictPreservedSnapshots(0, undefined, NOW);

    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(false);
    expect(registry.has("viewed")).toBe(true); // guarded survives even at max 0
  });
});
