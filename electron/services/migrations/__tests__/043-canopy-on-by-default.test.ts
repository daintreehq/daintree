import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migration043 } from "../043-canopy-on-by-default.js";

function run(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = structuredClone(initial);
  const store = {
    get: vi.fn((key: string) => structuredClone(data[key])),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration043.up>[0];
  migration043.up(store);
  return { data, store };
}

describe("migration043 — Canopy on by default", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is version 43", () => {
    expect(migration043.version).toBe(43);
  });

  it("turns on a user still in unset", () => {
    const { data } = run({ canopyMode: "unset", other: 1 });
    expect(data).toEqual({ canopyMode: "on", other: 1 });
  });

  it("keeps a user who hid Canopy hidden", () => {
    const { data, store } = run({ canopyMode: "hidden" });
    expect(data.canopyMode).toBe("hidden");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("leaves a user already on alone", () => {
    const { store } = run({ canopyMode: "on" });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("writes nothing when no mode was stored", () => {
    const { data, store } = run({});
    expect(store.set).not.toHaveBeenCalled();
    expect("canopyMode" in data).toBe(false);
  });
});
