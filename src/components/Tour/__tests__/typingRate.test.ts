import { describe, expect, it } from "vitest";
import { typingRate } from "../mockup/TourMock";

describe("typingRate", () => {
  it("keeps the floor pace when there is time to spare", () => {
    expect(typingRate(10, 0, 10, 20)).toBe(20);
  });

  it("speeds up so the text is done just before the cue it leads to", () => {
    const rate = typingRate(30, 10, 11.2, 22);
    expect(10 + 30 / rate).toBeLessThan(11.2);
    expect(rate).toBeGreaterThan(22);
  });

  it("never stalls when the cue arrives before typing could start", () => {
    expect(typingRate(30, 12, 11, 22)).toBeGreaterThan(22);
  });

  it("uses the floor pace without a cue to finish by", () => {
    expect(typingRate(30, 0, undefined, 22)).toBe(22);
  });
});
