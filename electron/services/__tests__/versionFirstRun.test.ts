import { beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({ getVersion: vi.fn(() => "0.39.0") }));
const storeData = vi.hoisted(() => new Map<string, unknown>());
const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => storeData.get(key)),
  set: vi.fn((key: string, value: unknown) => {
    storeData.set(key, value);
  }),
}));

vi.mock("electron", () => ({ app: appMock }));
vi.mock("../../store.js", () => ({ store: storeMock }));

import {
  getVersionFirstRunBoundary,
  recordVersionFirstRun,
  resolveVersionFirstRun,
  toVersionFirstRunBoundary,
} from "../versionFirstRun.js";

describe("resolveVersionFirstRun", () => {
  it("records a baseline with no timestamp when nothing is stored", () => {
    expect(resolveVersionFirstRun(undefined, "0.39.0", 1000)).toEqual({
      version: "0.39.0",
      firstRunAtMs: null,
    });
  });

  it("treats a malformed record as nothing stored", () => {
    for (const stored of [
      null,
      "0.38.0",
      { version: 1 },
      { version: "0.38.0", firstRunAtMs: "x" },
    ]) {
      expect(resolveVersionFirstRun(stored, "0.39.0", 1000)).toEqual({
        version: "0.39.0",
        firstRunAtMs: null,
      });
    }
  });

  it("leaves a current record alone", () => {
    expect(resolveVersionFirstRun({ version: "0.39.0", firstRunAtMs: 500 }, "0.39.0", 1000)).toBe(
      null
    );
    expect(resolveVersionFirstRun({ version: "0.39.0", firstRunAtMs: null }, "0.39.0", 1000)).toBe(
      null
    );
  });

  it("stamps the boot time when the version string changes in either direction", () => {
    expect(
      resolveVersionFirstRun({ version: "0.38.0", firstRunAtMs: null }, "0.39.0", 1000)
    ).toEqual({ version: "0.39.0", firstRunAtMs: 1000 });
    expect(resolveVersionFirstRun({ version: "0.40.0", firstRunAtMs: 5 }, "0.39.0", 1000)).toEqual({
      version: "0.39.0",
      firstRunAtMs: 1000,
    });
    // A prerelease sorts below its stable release under semver; it is still a change.
    expect(
      resolveVersionFirstRun(
        { version: "0.39.0-nightly.20251231", firstRunAtMs: 5 },
        "0.39.0",
        1000
      )
    ).toEqual({ version: "0.39.0", firstRunAtMs: 1000 });
  });
});

describe("toVersionFirstRunBoundary", () => {
  it("returns the boundary only for a timestamped record of the running version", () => {
    expect(
      toVersionFirstRunBoundary({ version: "0.39.0", firstRunAtMs: 1000 }, "0.39.0", 10_000)
    ).toEqual({
      version: "0.39.0",
      firstRunAtMs: 1000,
    });
    expect(
      toVersionFirstRunBoundary({ version: "0.39.0", firstRunAtMs: null }, "0.39.0", 10_000)
    ).toBe(null);
    expect(
      toVersionFirstRunBoundary({ version: "0.38.0", firstRunAtMs: 1000 }, "0.39.0", 10_000)
    ).toBe(null);
    expect(toVersionFirstRunBoundary(undefined, "0.39.0", 10_000)).toBe(null);
  });

  it("ignores a boundary that is non-positive or in the future", () => {
    expect(
      toVersionFirstRunBoundary({ version: "0.39.0", firstRunAtMs: -5 }, "0.39.0", 10_000)
    ).toBe(null);
    expect(
      toVersionFirstRunBoundary({ version: "0.39.0", firstRunAtMs: 20_000 }, "0.39.0", 10_000)
    ).toBe(null);
  });
});

describe("recordVersionFirstRun across boots", () => {
  beforeEach(() => {
    storeData.clear();
    vi.clearAllMocks();
  });

  it("offers no boundary until a version change is observed, then keeps the first launch", () => {
    appMock.getVersion.mockReturnValue("0.38.0");
    recordVersionFirstRun(100);
    recordVersionFirstRun(200);
    expect(getVersionFirstRunBoundary()).toBe(null);
    expect(storeMock.set).toHaveBeenCalledTimes(1);

    appMock.getVersion.mockReturnValue("0.39.0");
    recordVersionFirstRun(300);
    recordVersionFirstRun(400);
    expect(getVersionFirstRunBoundary()).toEqual({ version: "0.39.0", firstRunAtMs: 300 });
    expect(storeMock.set).toHaveBeenCalledTimes(2);
  });

  it("reports an unknown boundary instead of throwing when the settings read fails", () => {
    storeMock.get.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(getVersionFirstRunBoundary()).toBe(null);
  });
});
