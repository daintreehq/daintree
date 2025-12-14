import { describe, it, expect } from "vitest";
import { getAutoGridCols } from "../terminalLayout";

describe("getAutoGridCols", () => {
  describe("edge cases", () => {
    it("should return 1 for count of 0", () => {
      expect(getAutoGridCols(0, null)).toBe(1);
    });

    it("should return 1 for count of 1", () => {
      expect(getAutoGridCols(1, null)).toBe(1);
      expect(getAutoGridCols(1, 1000)).toBe(1);
      expect(getAutoGridCols(1, 2000)).toBe(1);
    });

    it("should return 2 for count of 2", () => {
      expect(getAutoGridCols(2, null)).toBe(2);
      expect(getAutoGridCols(2, 1000)).toBe(2);
      expect(getAutoGridCols(2, 2000)).toBe(2);
    });

    it("should handle negative counts defensively", () => {
      expect(getAutoGridCols(-1, null)).toBe(1);
      expect(getAutoGridCols(-10, null)).toBe(1);
    });
  });

  describe("count of 3 with responsive width", () => {
    it("should return 3 for narrow screens (< 900px)", () => {
      expect(getAutoGridCols(3, 0)).toBe(3);
      expect(getAutoGridCols(3, 800)).toBe(3);
      expect(getAutoGridCols(3, 899)).toBe(3);
    });

    it("should return 3 for wide screens (>= 900px)", () => {
      expect(getAutoGridCols(3, 900)).toBe(3);
      expect(getAutoGridCols(3, 901)).toBe(3);
      expect(getAutoGridCols(3, 1000)).toBe(3);
      expect(getAutoGridCols(3, 1600)).toBe(3);
      expect(getAutoGridCols(3, 2560)).toBe(3);
    });

    it("should return 3 when width is null (default to narrow)", () => {
      expect(getAutoGridCols(3, null)).toBe(3);
    });
  });

  describe("deterministic rectangular layouts", () => {
    it("should return 2 for count of 4 (2x2 grid)", () => {
      expect(getAutoGridCols(4, null)).toBe(2);
      expect(getAutoGridCols(4, 2000)).toBe(2);
    });

    it("should return 3 for counts 5-6 (2x3 grid)", () => {
      expect(getAutoGridCols(5, null)).toBe(3);
      expect(getAutoGridCols(6, null)).toBe(3);
    });

    it("should return 4 for counts 7-8 (2x4 grid)", () => {
      expect(getAutoGridCols(7, null)).toBe(4);
      expect(getAutoGridCols(8, null)).toBe(4);
    });

    it("should return 3 for count of 9 (3x3 grid)", () => {
      expect(getAutoGridCols(9, null)).toBe(3);
    });

    it("should return 4 for counts 10+ (4 columns, rows grow)", () => {
      expect(getAutoGridCols(10, null)).toBe(4);
      expect(getAutoGridCols(11, null)).toBe(4);
      expect(getAutoGridCols(12, null)).toBe(4);
      expect(getAutoGridCols(13, null)).toBe(4);
      expect(getAutoGridCols(14, null)).toBe(4);
      expect(getAutoGridCols(15, null)).toBe(4);
      expect(getAutoGridCols(16, null)).toBe(4);
      expect(getAutoGridCols(20, null)).toBe(4);
      expect(getAutoGridCols(100, null)).toBe(4);
    });
  });

  describe("width independence for non-3 counts", () => {
    it("should ignore width for counts other than 3", () => {
      // Count 0 - width doesn't matter
      expect(getAutoGridCols(0, 800)).toBe(1);
      expect(getAutoGridCols(0, 2000)).toBe(1);

      // Count 1 - width doesn't matter
      expect(getAutoGridCols(1, 800)).toBe(1);
      expect(getAutoGridCols(1, 2000)).toBe(1);

      // Count 2 - width doesn't matter
      expect(getAutoGridCols(2, 800)).toBe(2);
      expect(getAutoGridCols(2, 2000)).toBe(2);

      // Count 4 - width doesn't matter
      expect(getAutoGridCols(4, 800)).toBe(2);
      expect(getAutoGridCols(4, 2000)).toBe(2);

      // Count 6 - width doesn't matter
      expect(getAutoGridCols(6, 800)).toBe(3);
      expect(getAutoGridCols(6, 2000)).toBe(3);

      // Count 9 - width doesn't matter
      expect(getAutoGridCols(9, 800)).toBe(3);
      expect(getAutoGridCols(9, 2000)).toBe(3);

      // Count 10+ - width doesn't matter
      expect(getAutoGridCols(10, 800)).toBe(4);
      expect(getAutoGridCols(10, 2000)).toBe(4);
      expect(getAutoGridCols(12, 800)).toBe(4);
      expect(getAutoGridCols(12, 2000)).toBe(4);
    });
  });

  describe("boundary verification at max grid size", () => {
    it("should handle 16 terminals correctly (max grid)", () => {
      expect(getAutoGridCols(16, null)).toBe(4);
    });

    it("should handle 17 terminals (one over max)", () => {
      expect(getAutoGridCols(17, null)).toBe(4);
    });
  });
});
