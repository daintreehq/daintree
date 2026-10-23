import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import {
  advanceProjectLayoutSeed,
  captureProjectLayoutSeed,
  getProjectLayoutSeed,
} from "../projectLayoutSeeds.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

describe("projectLayoutSeeds (#13782)", () => {
  beforeEach(() => {
    storeMock.data.clear();
    storeMock.get.mockImplementation((key: string) => storeMock.data.get(key));
    storeMock.set.mockClear();
  });

  it("has no record before a project's first hydrate", () => {
    expect(getProjectLayoutSeed(PROJECT_A)).toBeNull();
  });

  it("records a first open as pending and anything else as settled", () => {
    expect(captureProjectLayoutSeed(PROJECT_A, true, 5)).toEqual({ status: "pending", at: 5 });
    expect(captureProjectLayoutSeed(PROJECT_B, false, 6)).toEqual({
      status: "settled",
      outcome: "ineligible",
      at: 6,
    });
    expect(getProjectLayoutSeed(PROJECT_A)?.status).toBe("pending");
    expect(getProjectLayoutSeed(PROJECT_B)?.status).toBe("settled");
  });

  it("lets only the first hydrate decide", () => {
    // A later hydrate that finds no state — a cleared or quarantined file —
    // must not make a project that was seen before look new.
    captureProjectLayoutSeed(PROJECT_A, false, 1);
    expect(captureProjectLayoutSeed(PROJECT_A, true, 2)).toEqual({
      status: "settled",
      outcome: "ineligible",
      at: 1,
    });
    expect(storeMock.set).toHaveBeenCalledTimes(1);
  });

  it("advances only from the status the caller saw", () => {
    captureProjectLayoutSeed(PROJECT_A, true, 1);

    const first = advanceProjectLayoutSeed(PROJECT_A, "pending", "settled", "applied", 2);
    const second = advanceProjectLayoutSeed(PROJECT_A, "pending", "settled", "applied", 3);

    // Two views racing for the same seed: exactly one consumes it.
    expect(first).toEqual({
      advanced: true,
      record: { status: "settled", outcome: "applied", at: 2 },
    });
    expect(second).toEqual({ advanced: false, record: first.record });
  });

  it("walks pending → offered → settled, and never back", () => {
    captureProjectLayoutSeed(PROJECT_A, true, 1);
    expect(advanceProjectLayoutSeed(PROJECT_A, "pending", "offered").advanced).toBe(true);
    expect(advanceProjectLayoutSeed(PROJECT_A, "pending", "settled").advanced).toBe(false);
    expect(advanceProjectLayoutSeed(PROJECT_A, "offered", "settled", "dismissed").advanced).toBe(
      true
    );
    expect(getProjectLayoutSeed(PROJECT_A)?.outcome).toBe("dismissed");
    expect(() => advanceProjectLayoutSeed(PROJECT_A, "settled", "pending")).toThrow(
      /cannot move from settled to pending/
    );
    expect(() => advanceProjectLayoutSeed(PROJECT_A, "offered", "pending")).toThrow();
  });

  it("does not advance a project it has never seen", () => {
    expect(advanceProjectLayoutSeed(PROJECT_A, "pending", "settled")).toEqual({
      advanced: false,
      record: null,
    });
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("keeps other projects' records when writing one", () => {
    captureProjectLayoutSeed(PROJECT_A, true, 1);
    captureProjectLayoutSeed(PROJECT_B, true, 2);
    advanceProjectLayoutSeed(PROJECT_A, "pending", "offered", undefined, 3);
    expect(getProjectLayoutSeed(PROJECT_B)).toEqual({ status: "pending", at: 2 });
  });

  it("reads a malformed record as settled, never as a fresh first open", () => {
    storeMock.data.set("projectLayoutSeeds", {
      [PROJECT_A]: { status: "bogus" },
      [PROJECT_B]: "not an object",
    });
    expect(getProjectLayoutSeed(PROJECT_A)?.status).toBe("settled");
    expect(getProjectLayoutSeed(PROJECT_B)?.status).toBe("settled");
    expect(captureProjectLayoutSeed(PROJECT_A, true).status).toBe("settled");
  });

  it("surfaces a read failure rather than reading it as no record", () => {
    storeMock.get.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(() => getProjectLayoutSeed(PROJECT_A)).toThrow(/EACCES/);
    expect(() => captureProjectLayoutSeed(PROJECT_A, true)).toThrow(/EACCES/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a project's", () => {
    expect(() => captureProjectLayoutSeed("scratch-1", true)).toThrow(/project workspace id/);
    expect(() => advanceProjectLayoutSeed("scratch-1", "pending", "offered")).toThrow(
      /project workspace id/
    );
  });
});
