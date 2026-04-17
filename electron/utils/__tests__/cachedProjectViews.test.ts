import { describe, expect, it } from "vitest";

import {
  computeDefaultCachedViews,
  effectiveCachedProjectViews,
  isValidCachedProjectViews,
} from "../cachedProjectViews.js";

const GIB = 1024 ** 3;

describe("computeDefaultCachedViews", () => {
  it("returns 1 for machines with 16 GiB or less", () => {
    expect(computeDefaultCachedViews(4 * GIB)).toBe(1);
    expect(computeDefaultCachedViews(8 * GIB)).toBe(1);
    expect(computeDefaultCachedViews(16 * GIB)).toBe(1);
  });

  it("returns 1 for machines between 16 and 32 GiB", () => {
    expect(computeDefaultCachedViews(24 * GIB)).toBe(1);
    expect(computeDefaultCachedViews(32 * GIB - 1)).toBe(1);
  });

  it("returns 2 at the 32 GiB threshold and up to just below 64 GiB", () => {
    expect(computeDefaultCachedViews(32 * GIB)).toBe(2);
    expect(computeDefaultCachedViews(48 * GIB)).toBe(2);
    expect(computeDefaultCachedViews(64 * GIB - 1)).toBe(2);
  });

  it("returns 3 at the 64 GiB threshold and above", () => {
    expect(computeDefaultCachedViews(64 * GIB)).toBe(3);
    expect(computeDefaultCachedViews(96 * GIB)).toBe(3);
    expect(computeDefaultCachedViews(128 * GIB)).toBe(3);
  });

  it("falls back to 1 for invalid or non-positive inputs", () => {
    expect(computeDefaultCachedViews(0)).toBe(1);
    expect(computeDefaultCachedViews(-1)).toBe(1);
    expect(computeDefaultCachedViews(Number.NaN)).toBe(1);
    expect(computeDefaultCachedViews(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("isValidCachedProjectViews", () => {
  it("accepts integers within [1, 5]", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(isValidCachedProjectViews(n)).toBe(true);
    }
  });

  it("rejects out-of-range integers", () => {
    expect(isValidCachedProjectViews(0)).toBe(false);
    expect(isValidCachedProjectViews(6)).toBe(false);
    expect(isValidCachedProjectViews(-1)).toBe(false);
  });

  it("rejects non-integer numbers and non-numbers", () => {
    expect(isValidCachedProjectViews(2.5)).toBe(false);
    expect(isValidCachedProjectViews(Number.NaN)).toBe(false);
    expect(isValidCachedProjectViews("3")).toBe(false);
    expect(isValidCachedProjectViews(null)).toBe(false);
    expect(isValidCachedProjectViews(undefined)).toBe(false);
  });
});

describe("effectiveCachedProjectViews", () => {
  const mem = (gib: number) => gib * GIB;

  it("preserves a valid stored preference regardless of RAM or E2E mode", () => {
    expect(effectiveCachedProjectViews(2, { totalMemBytes: mem(128), isE2E: true })).toBe(2);
    expect(effectiveCachedProjectViews(5, { totalMemBytes: mem(8), isE2E: false })).toBe(5);
    expect(effectiveCachedProjectViews(1, { totalMemBytes: mem(64), isE2E: true })).toBe(1);
  });

  it("returns the E2E override when no valid preference is stored", () => {
    expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8), isE2E: true })).toBe(4);
    expect(effectiveCachedProjectViews(null, { totalMemBytes: mem(128), isE2E: true })).toBe(4);
    expect(effectiveCachedProjectViews("bogus", { totalMemBytes: mem(8), isE2E: true })).toBe(4);
  });

  it("derives from RAM when no preference and not in E2E mode", () => {
    expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8), isE2E: false })).toBe(1);
    expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(32), isE2E: false })).toBe(
      2
    );
    expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(64), isE2E: false })).toBe(
      3
    );
  });

  it("treats corrupted stored values as absent and falls back", () => {
    const ramDefault64 = { totalMemBytes: mem(64), isE2E: false };
    expect(effectiveCachedProjectViews("bogus", ramDefault64)).toBe(3);
    expect(effectiveCachedProjectViews(99, ramDefault64)).toBe(3);
    expect(effectiveCachedProjectViews(0, ramDefault64)).toBe(3);
    expect(effectiveCachedProjectViews(-1, ramDefault64)).toBe(3);
    expect(effectiveCachedProjectViews(2.5, ramDefault64)).toBe(3);
    expect(effectiveCachedProjectViews(Number.NaN, ramDefault64)).toBe(3);
    expect(effectiveCachedProjectViews({ v: 2 }, ramDefault64)).toBe(3);
  });

  it("honors the E2E override when stored value is invalid", () => {
    expect(effectiveCachedProjectViews(99, { totalMemBytes: mem(64), isE2E: true })).toBe(4);
    expect(effectiveCachedProjectViews("bogus", { totalMemBytes: mem(8), isE2E: true })).toBe(4);
    expect(effectiveCachedProjectViews(0, { totalMemBytes: mem(128), isE2E: true })).toBe(4);
  });

  it("prefers an explicit opts.isE2E over the environment variable", () => {
    const prev = process.env.DAINTREE_E2E_MODE;
    try {
      process.env.DAINTREE_E2E_MODE = "1";
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8), isE2E: false })).toBe(
        1
      );
      delete process.env.DAINTREE_E2E_MODE;
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8), isE2E: true })).toBe(
        4
      );
    } finally {
      if (prev === undefined) {
        delete process.env.DAINTREE_E2E_MODE;
      } else {
        process.env.DAINTREE_E2E_MODE = prev;
      }
    }
  });

  it("reads DAINTREE_E2E_MODE from the environment when isE2E is not provided", () => {
    const prev = process.env.DAINTREE_E2E_MODE;
    try {
      process.env.DAINTREE_E2E_MODE = "1";
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8) })).toBe(4);
      process.env.DAINTREE_E2E_MODE = "0";
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8) })).toBe(1);
      process.env.DAINTREE_E2E_MODE = "false";
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8) })).toBe(1);
      delete process.env.DAINTREE_E2E_MODE;
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8) })).toBe(1);
    } finally {
      if (prev === undefined) {
        delete process.env.DAINTREE_E2E_MODE;
      } else {
        process.env.DAINTREE_E2E_MODE = prev;
      }
    }
  });
});
