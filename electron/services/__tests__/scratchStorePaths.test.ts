import { describe, it, expect } from "vitest";
import path from "path";
import { isValidScratchId, getScratchDir, scratchStateFilePath } from "../scratchStorePaths.js";

const BASE = path.resolve("/test/userData/scratches");
const VALID_UUID = "12345678-1234-4567-8abc-1234567890ab"; // valid UUID v4 shape

describe("scratchStorePaths", () => {
  describe("isValidScratchId", () => {
    it("accepts a canonical UUID v4", () => {
      expect(isValidScratchId(VALID_UUID)).toBe(true);
    });

    it("accepts uppercase hex UUID v4", () => {
      expect(isValidScratchId(VALID_UUID.toUpperCase())).toBe(true);
    });

    it("rejects SHA256-hex (project ID format)", () => {
      // Project IDs are 64 hex chars; scratch IDs must NOT pass through this
      // path or `getScratchDir` would silently traverse a shared root.
      expect(isValidScratchId("a".repeat(64))).toBe(false);
    });

    it("rejects path traversal attempts", () => {
      expect(isValidScratchId("../escape")).toBe(false);
      expect(isValidScratchId("..")).toBe(false);
      expect(isValidScratchId("")).toBe(false);
    });

    it("rejects malformed UUIDs", () => {
      expect(isValidScratchId("12345678-1234-1234-1234-123456789012")).toBe(false); // version != 4
      expect(isValidScratchId("not-a-uuid")).toBe(false);
      expect(isValidScratchId("12345678-1234-4567-8abc-12345678")).toBe(false); // too short
    });
  });

  describe("getScratchDir", () => {
    it("returns the joined scratch dir for a valid UUID", () => {
      expect(getScratchDir(BASE, VALID_UUID)).toBe(path.join(BASE, VALID_UUID));
    });

    it("returns null for an invalid id", () => {
      expect(getScratchDir(BASE, "invalid")).toBeNull();
      expect(getScratchDir(BASE, "../escape")).toBeNull();
      expect(getScratchDir(BASE, "")).toBeNull();
    });

    it("does not allow escape via embedded separators", () => {
      const escaped = `${VALID_UUID}/../escape`;
      expect(getScratchDir(BASE, escaped)).toBeNull();
    });
  });

  describe("scratchStateFilePath", () => {
    it("returns state.json path under the scratch dir", () => {
      expect(scratchStateFilePath(BASE, VALID_UUID)).toBe(
        path.join(BASE, VALID_UUID, "state.json")
      );
    });

    it("returns null for invalid ids", () => {
      expect(scratchStateFilePath(BASE, "invalid")).toBeNull();
    });
  });
});
