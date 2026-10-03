import { describe, expect, it } from "vitest";
import { isTriageRead } from "../triageStore";

const SPAWNED = 1_000;

describe("isTriageRead", () => {
  it("is unread until the run is opened", () => {
    expect(isTriageRead(undefined, SPAWNED, null)).toBe(false);
  });

  it("stays read until the screen is read anew after the run was opened", () => {
    const read = { spawnedAt: SPAWNED, at: 5_000 };
    expect(isTriageRead(read, SPAWNED, { spawnedAt: SPAWNED, observedAt: 4_000 })).toBe(true);
    expect(isTriageRead(read, SPAWNED, { spawnedAt: SPAWNED, observedAt: 6_000 })).toBe(false);
  });

  it("counts a run opened before its screen was ever read as read", () => {
    expect(isTriageRead({ spawnedAt: SPAWNED, at: 5_000 }, SPAWNED, null)).toBe(true);
  });

  it("never carries a read over to a terminal respawned under the same id", () => {
    expect(isTriageRead({ spawnedAt: SPAWNED, at: 5_000 }, SPAWNED + 1, null)).toBe(false);
  });
});
