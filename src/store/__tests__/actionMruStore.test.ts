// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients/appClient", () => ({
  appClient: {
    setState: vi.fn(),
  },
}));

import { useActionMruStore } from "../actionMruStore";
import type { ActionFrecencyEntry } from "@shared/types/actions";

describe("actionMruStore", () => {
  beforeEach(() => {
    useActionMruStore.setState({ actionFrecencyEntries: new Map() });
  });

  it("records a new action with cold-start score", () => {
    useActionMruStore.getState().recordActionMru("a.action");
    const entries = useActionMruStore.getState().actionFrecencyEntries;

    expect(entries.size).toBe(1);
    const entry = entries.get("a.action");
    expect(entry).toBeDefined();
    expect(entry!.score).toBeGreaterThan(0);
    expect(entry!.lastAccessedAt).toBeGreaterThan(0);
  });

  it("re-recording an existing action updates its entry", () => {
    useActionMruStore.getState().recordActionMru("a.action");
    const firstEntry = useActionMruStore.getState().actionFrecencyEntries.get("a.action");
    expect(firstEntry).toBeDefined();

    useActionMruStore.getState().recordActionMru("a.action");
    const secondEntry = useActionMruStore.getState().actionFrecencyEntries.get("a.action");
    expect(secondEntry).toBeDefined();
    expect(secondEntry!.score).toBe(firstEntry!.score);
  });

  it("caps entries at 20", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `action.${i}`);
    for (const id of ids) {
      useActionMruStore.getState().recordActionMru(id);
    }

    expect(useActionMruStore.getState().actionFrecencyEntries.size).toBe(20);
  });

  it("keeps entries with highest scores when exceeding 20", () => {
    for (let i = 0; i < 25; i++) {
      useActionMruStore.getState().recordActionMru(`action.${i}`);
    }

    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted.length).toBe(20);

    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.score).toBeLessThanOrEqual(sorted[i - 1]!.score);
    }
  });

  it("migrates legacy string[] format", () => {
    const legacyList = ["action.0", "action.1", "action.2"];
    useActionMruStore.getState().hydrateActionMru(legacyList);

    const entries = useActionMruStore.getState().actionFrecencyEntries;
    expect(entries.size).toBe(3);

    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted[0]!.id).toBe("action.0");
    expect(sorted[1]!.id).toBe("action.1");
    expect(sorted[2]!.id).toBe("action.2");

    expect(sorted[0]!.score).toBeGreaterThan(sorted[1]!.score);
    expect(sorted[1]!.score).toBeGreaterThan(sorted[2]!.score);
  });

  it("hydrates from new ActionFrecencyEntry[] format", () => {
    const entries: ActionFrecencyEntry[] = [
      { id: "action.0", score: 10, lastAccessedAt: 1000 },
      { id: "action.1", score: 5, lastAccessedAt: 2000 },
      { id: "action.2", score: 15, lastAccessedAt: 3000 },
    ];
    useActionMruStore.getState().hydrateActionMru(entries);

    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted.length).toBe(3);
    expect(sorted[0]!.id).toBe("action.2");
    expect(sorted[1]!.id).toBe("action.0");
    expect(sorted[2]!.id).toBe("action.1");
  });

  it("truncates hydrated list to 20", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      id: `action.${i}`,
      score: i,
      lastAccessedAt: i * 1000,
    }));
    useActionMruStore.getState().hydrateActionMru(entries);

    expect(useActionMruStore.getState().actionFrecencyEntries.size).toBe(20);
  });

  it("clears all entries", () => {
    useActionMruStore.getState().recordActionMru("a.action");
    useActionMruStore.getState().recordActionMru("b.action");

    useActionMruStore.getState().clearActionMru();
    expect(useActionMruStore.getState().actionFrecencyEntries.size).toBe(0);
  });

  it("getSortedActionMruList returns entries sorted by score", () => {
    const entries: ActionFrecencyEntry[] = [
      { id: "low", score: 1, lastAccessedAt: 1000 },
      { id: "high", score: 10, lastAccessedAt: 2000 },
      { id: "mid", score: 5, lastAccessedAt: 3000 },
    ];
    useActionMruStore.getState().hydrateActionMru(entries);

    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted[0]!.id).toBe("high");
    expect(sorted[1]!.id).toBe("mid");
    expect(sorted[2]!.id).toBe("low");
  });

  it("getSortedActionMruList uses lastAccessedAt as tiebreaker", () => {
    const entries: ActionFrecencyEntry[] = [
      { id: "older", score: 5, lastAccessedAt: 1000 },
      { id: "newer", score: 5, lastAccessedAt: 2000 },
    ];
    useActionMruStore.getState().hydrateActionMru(entries);

    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted[0]!.id).toBe("newer");
    expect(sorted[1]!.id).toBe("older");
  });

  it("getSortedActionMruList uses id as final tiebreaker", () => {
    const entries: ActionFrecencyEntry[] = [
      { id: "z.action", score: 5, lastAccessedAt: 1000 },
      { id: "a.action", score: 5, lastAccessedAt: 1000 },
    ];
    useActionMruStore.getState().hydrateActionMru(entries);

    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted[0]!.id).toBe("a.action");
    expect(sorted[1]!.id).toBe("z.action");
  });

  it("deduplicates entries on hydration", () => {
    const entries: ActionFrecencyEntry[] = [
      { id: "dup", score: 1, lastAccessedAt: 1000 },
      { id: "dup", score: 10, lastAccessedAt: 2000 },
    ];
    useActionMruStore.getState().hydrateActionMru(entries);

    expect(useActionMruStore.getState().actionFrecencyEntries.size).toBe(1);
  });

  it("does not update state when recording same action immediately", () => {
    useActionMruStore.getState().recordActionMru("a.action");
    const before = useActionMruStore.getState().actionFrecencyEntries;

    useActionMruStore.getState().recordActionMru("a.action");
    const after = useActionMruStore.getState().actionFrecencyEntries;

    expect(before).toBe(after);
  });
});
