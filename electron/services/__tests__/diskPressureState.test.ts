import { afterEach, describe, expect, it } from "vitest";
import {
  getWritesSuppressed,
  setWritesSuppressed,
  resetWritesSuppressedForTesting,
} from "../diskPressureState.js";

describe("diskPressureState", () => {
  afterEach(() => {
    resetWritesSuppressedForTesting();
  });

  it("defaults to writes allowed", () => {
    expect(getWritesSuppressed()).toBe(false);
  });

  it("round-trips set/get", () => {
    setWritesSuppressed(true);
    expect(getWritesSuppressed()).toBe(true);
    setWritesSuppressed(false);
    expect(getWritesSuppressed()).toBe(false);
  });

  it("resetWritesSuppressedForTesting returns flag to false", () => {
    setWritesSuppressed(true);
    expect(getWritesSuppressed()).toBe(true);
    resetWritesSuppressedForTesting();
    expect(getWritesSuppressed()).toBe(false);
  });
});
