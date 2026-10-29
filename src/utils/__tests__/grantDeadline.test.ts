import { describe, expect, it } from "vitest";
import { grantDeadline } from "../grantDeadline";

describe("grantDeadline", () => {
  it("ends at the sliding expiry while it comes before the ceiling", () => {
    expect(grantDeadline(1_000, 2_000)).toEqual({ endsAt: 1_000, atCeiling: false });
  });

  it("ends at the ceiling once a slide reaches it", () => {
    expect(grantDeadline(2_000, 2_000)).toEqual({ endsAt: 2_000, atCeiling: true });
    expect(grantDeadline(3_000, 2_000)).toEqual({ endsAt: 2_000, atCeiling: true });
  });

  it("falls back to the sliding expiry when the ceiling is unknown", () => {
    expect(grantDeadline(1_000)).toEqual({ endsAt: 1_000, atCeiling: false });
  });
});
