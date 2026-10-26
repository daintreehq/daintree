import { describe, expect, it } from "vitest";
import {
  CANOPY_RESUME_MS,
  canopyResumeFresh,
  canopyResumeTarget,
  type CanopyResume,
} from "../canopyResume";

const resume = (over: Partial<CanopyResume> = {}): CanopyResume => ({
  at: 1_000,
  hostId: null,
  query: "",
  runId: "c",
  order: ["a", "b", "c", "d", "e"],
  ...over,
});

describe("canopyResumeFresh", () => {
  it("holds for thirty minutes and no longer", () => {
    expect(canopyResumeFresh(resume(), 1_000 + CANOPY_RESUME_MS)).toBe(true);
    expect(canopyResumeFresh(resume(), 1_001 + CANOPY_RESUME_MS)).toBe(false);
    expect(canopyResumeFresh(null, 1_000)).toBe(false);
  });
});

describe("canopyResumeTarget", () => {
  it("is the run left when it is still listed", () => {
    expect(canopyResumeTarget(resume(), ["a", "c"])).toBe("c");
  });
  it("gives a gone run's place to the next one, then the one before", () => {
    expect(canopyResumeTarget(resume(), ["a", "b", "d", "e"])).toBe("d");
    expect(canopyResumeTarget(resume(), ["a", "b"])).toBe("b");
    expect(canopyResumeTarget(resume(), ["a", "e"])).toBe("e");
  });
  it("is nothing when nothing it knew is listed", () => {
    expect(canopyResumeTarget(resume(), ["z"])).toBeNull();
    expect(canopyResumeTarget(resume({ order: [] }), ["a"])).toBeNull();
  });
});
