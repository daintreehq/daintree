// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients/appClient", () => ({
  appClient: {
    setState: vi.fn(),
  },
}));

import { useActionMruStore } from "../actionMruStore";
import type { ActionFrecencyEntry, ActionUsageEntry } from "@shared/types/actions";
import { USAGE_WINDOW_MS } from "@shared/utils/actionUsage";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("actionMruStore (rolling 7-day usage count)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useActionMruStore.setState({ actionUsageEntries: new Map() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a new action as a single in-window use", () => {
    useActionMruStore.getState().recordActionMru("a.action");
    const list = useActionMruStore.getState().getSortedActionMruList();
    expect(list).toEqual([{ id: "a.action", score: 1, lastAccessedAt: NOW }]);
  });

  it("increments the usage count each time the action is recorded", () => {
    useActionMruStore.getState().recordActionMru("a.action");
    vi.setSystemTime(NOW + 1000);
    useActionMruStore.getState().recordActionMru("a.action");
    vi.setSystemTime(NOW + 2000);
    useActionMruStore.getState().recordActionMru("a.action");

    const [entry] = useActionMruStore.getState().getSortedActionMruList();
    expect(entry!.score).toBe(3);
    expect(entry!.lastAccessedAt).toBe(NOW + 2000);
  });

  it("drops an entry whose only uses fall outside the 7-day window", () => {
    const old = NOW - USAGE_WINDOW_MS - DAY;
    useActionMruStore.getState().hydrateActionMru([{ id: "stale", uses: [old, old + 1000] }]);
    expect(useActionMruStore.getState().getSortedActionMruList()).toEqual([]);
  });

  it("prunes only out-of-window uses, keeping the recent ones", () => {
    const recent = NOW - DAY;
    const stale = NOW - USAGE_WINDOW_MS - DAY;
    useActionMruStore.getState().hydrateActionMru([{ id: "mixed", uses: [stale, recent] }]);
    expect(useActionMruStore.getState().getSortedActionMruList()).toEqual([
      { id: "mixed", score: 1, lastAccessedAt: recent },
    ]);
  });

  it("caps recorded entries at 20, keeping the most recent when counts tie", () => {
    for (let i = 0; i < 25; i++) {
      vi.setSystemTime(NOW + i * 1000);
      useActionMruStore.getState().recordActionMru(`action.${i}`);
    }
    const list = useActionMruStore.getState().getSortedActionMruList();
    expect(list.length).toBe(20);
    const ids = new Set(list.map((e) => e.id));
    expect(ids.has("action.24")).toBe(true);
    expect(ids.has("action.0")).toBe(false);
  });

  it("migrates legacy string[] preserving recency order", () => {
    useActionMruStore.getState().hydrateActionMru(["action.0", "action.1", "action.2"]);
    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted.map((e) => e.id)).toEqual(["action.0", "action.1", "action.2"]);
    expect(sorted.every((e) => e.score === 1)).toBe(true);
    expect(sorted[0]!.lastAccessedAt).toBeGreaterThan(sorted[1]!.lastAccessedAt);
  });

  it("migrates legacy frecency entries into approximate in-window counts", () => {
    const entries: ActionFrecencyEntry[] = [
      { id: "action.a", score: 10, lastAccessedAt: NOW - DAY },
      { id: "action.b", score: 5, lastAccessedAt: NOW - DAY },
      { id: "action.c", score: 15, lastAccessedAt: NOW - DAY },
    ];
    useActionMruStore.getState().hydrateActionMru(entries);
    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted.map((e) => e.id)).toEqual(["action.c", "action.a", "action.b"]);
    expect(sorted[0]!.score).toBe(15);
    expect(sorted[2]!.score).toBe(5);
  });

  it("drops legacy frecency entries whose last access predates the window", () => {
    const entries: ActionFrecencyEntry[] = [
      { id: "stale", score: 50, lastAccessedAt: NOW - USAGE_WINDOW_MS - DAY },
    ];
    useActionMruStore.getState().hydrateActionMru(entries);
    expect(useActionMruStore.getState().getSortedActionMruList()).toEqual([]);
  });

  it("hydrates the new ActionUsageEntry[] format and ranks by count", () => {
    const entries: ActionUsageEntry[] = [
      { id: "action.0", uses: [NOW - 3000] },
      { id: "action.1", uses: [NOW - 2000, NOW - 1000] },
    ];
    useActionMruStore.getState().hydrateActionMru(entries);
    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted[0]!.id).toBe("action.1");
    expect(sorted[0]!.score).toBe(2);
    expect(sorted[1]!.score).toBe(1);
  });

  it("truncates a hydrated list to 20, keeping the highest-count entries", () => {
    const entries: ActionUsageEntry[] = Array.from({ length: 25 }, (_, i) => ({
      id: `action.${i}`,
      uses: Array.from({ length: i + 1 }, (_, n) => NOW - (n + 1) * 1000),
    }));
    useActionMruStore.getState().hydrateActionMru(entries);
    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted.length).toBe(20);
    expect(sorted[0]!.id).toBe("action.24");
  });

  it("sorts by count, then recency, then id", () => {
    const entries: ActionUsageEntry[] = [
      { id: "z.tie", uses: [NOW - 5000] },
      { id: "a.tie", uses: [NOW - 5000] },
      { id: "newer", uses: [NOW - 1000] },
      { id: "most", uses: [NOW - 3000, NOW - 2000] },
    ];
    useActionMruStore.getState().hydrateActionMru(entries);
    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted.map((e) => e.id)).toEqual(["most", "newer", "a.tie", "z.tie"]);
  });

  it("deduplicates entries on hydration (first occurrence wins)", () => {
    const entries: ActionUsageEntry[] = [
      { id: "dup", uses: [NOW - 1000] },
      { id: "dup", uses: [NOW - 2000, NOW - 3000] },
    ];
    useActionMruStore.getState().hydrateActionMru(entries);
    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted.length).toBe(1);
    expect(sorted[0]!.score).toBe(1);
  });

  it("clears all entries", () => {
    useActionMruStore.getState().recordActionMru("a.action");
    useActionMruStore.getState().recordActionMru("b.action");
    useActionMruStore.getState().clearActionMru();
    expect(useActionMruStore.getState().getSortedActionMruList()).toEqual([]);
  });
});
