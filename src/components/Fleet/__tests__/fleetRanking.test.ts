import { describe, it, expect } from "vitest";
import type { FleetSavedScope, SnapshotFleetSavedScope } from "@shared/types";
import { rankSavedFleets, rankPredicateFleets } from "../fleetRanking";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const snap = (
  id: string,
  overrides: Partial<SnapshotFleetSavedScope> = {}
): SnapshotFleetSavedScope => ({
  kind: "snapshot",
  id,
  name: id,
  terminalIds: ["t1"],
  createdAt: 0,
  ...overrides,
});

describe("rankSavedFleets", () => {
  it("places the highest-frecency snapshot first in usable", () => {
    const a = snap("a", { usageHistory: [NOW - 7 * DAY] }); // ~50
    const b = snap("b", { usageHistory: [NOW] }); // 100
    const c = snap("c", { usageHistory: [NOW, NOW - DAY, NOW - 2 * DAY] }); // ~250
    const { usable, stale } = rankSavedFleets([a, b, c], NOW, new Map());
    expect(stale).toEqual([]);
    expect(usable.map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("splits stale snapshots into a separate list", () => {
    const a = snap("a");
    const b = snap("b");
    const isStaleById = new Map([["b", true]]);
    const { usable, stale } = rankSavedFleets([a, b], NOW, isStaleById);
    expect(usable.map((s) => s.id)).toEqual(["a"]);
    expect(stale.map((s) => s.id)).toEqual(["b"]);
  });

  it("sorts stale sub-group by lastUsedAt desc with name tie-breaker", () => {
    const a = snap("a", { lastUsedAt: NOW - 2 * DAY, name: "alpha" });
    const b = snap("b", { lastUsedAt: NOW - DAY, name: "bravo" });
    const c = snap("c", { lastUsedAt: NOW - DAY, name: "charlie" });
    const isStaleById = new Map([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);
    const { stale } = rankSavedFleets([a, b, c], NOW, isStaleById);
    expect(stale.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("places new scopes (no usageHistory, no lastUsedAt) at the bottom of usable", () => {
    const fresh = snap("fresh", { usageHistory: [NOW] });
    const newScope = snap("new"); // no usageHistory, no lastUsedAt → frecency 0
    const { usable } = rankSavedFleets([newScope, fresh], NOW, new Map());
    expect(usable.map((s) => s.id)).toEqual(["fresh", "new"]);
  });

  it("seeds frecency from lastUsedAt when usageHistory is empty", () => {
    // A scope with lastUsedAt=NOW but no usageHistory should still rank
    // above a scope with one ancient usageHistory entry — otherwise a
    // brand-new save would sink below any fleet that has ever been
    // recalled (frecency decay bottoms out near zero for old timestamps).
    const freshStamp = snap("stamp", { lastUsedAt: NOW });
    const ancientRecall = snap("ancient", { usageHistory: [NOW - 365 * DAY] });
    const { usable } = rankSavedFleets([ancientRecall, freshStamp], NOW, new Map());
    expect(usable.map((s) => s.id)).toEqual(["stamp", "ancient"]);
  });

  it("breaks frecency ties by lastUsedAt desc", () => {
    // Same frecency score (each has 1 entry from 7 days ago) — lastUsedAt breaks the tie.
    const a = snap("a", { usageHistory: [NOW - 7 * DAY], lastUsedAt: NOW - 7 * DAY });
    const b = snap("b", { usageHistory: [NOW - 7 * DAY], lastUsedAt: NOW - 6 * DAY });
    const { usable } = rankSavedFleets([a, b], NOW, new Map());
    expect(usable.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("breaks lastUsedAt ties by createdAt desc", () => {
    const a = snap("a", { lastUsedAt: NOW, createdAt: 100 });
    const b = snap("b", { lastUsedAt: NOW, createdAt: 200 });
    const { usable } = rankSavedFleets([a, b], NOW, new Map());
    expect(usable.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("breaks createdAt ties by name localeCompare asc", () => {
    const a = snap("a", { lastUsedAt: NOW, createdAt: 100, name: "Bravo" });
    const b = snap("b", { lastUsedAt: NOW, createdAt: 100, name: "Alpha" });
    const { usable } = rankSavedFleets([a, b], NOW, new Map());
    expect(usable.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("returns empty arrays for empty input", () => {
    const { usable, stale } = rankSavedFleets([], NOW, new Map());
    expect(usable).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const a = snap("a", { usageHistory: [NOW] });
    const b = snap("b", { usageHistory: [NOW - 7 * DAY] });
    const input: FleetSavedScope[] = [a, b];
    const inputCopy: FleetSavedScope[] = [...input];
    rankSavedFleets(input, NOW, new Map());
    expect(input).toEqual(inputCopy);
  });
});

describe("rankPredicateFleets", () => {
  it("sorts predicates by frecency desc with the same tie-breaker chain", () => {
    const a: FleetSavedScope = {
      kind: "predicate",
      id: "a",
      name: "a",
      scope: "all",
      stateFilter: "waiting",
      createdAt: 0,
      usageHistory: [NOW - 7 * DAY],
    };
    const b: FleetSavedScope = {
      kind: "predicate",
      id: "b",
      name: "b",
      scope: "all",
      stateFilter: "working",
      createdAt: 0,
      usageHistory: [NOW, NOW - DAY],
    };
    const ranked = rankPredicateFleets([a, b], NOW);
    expect(ranked.map((s) => s.id)).toEqual(["b", "a"]);
  });
});
