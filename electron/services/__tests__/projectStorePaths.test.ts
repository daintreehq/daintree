import { describe, it, expect } from "vitest";
import path from "path";
import {
  stateFilePath,
  settingsFilePath,
  recipesFilePath,
  UTF8_BOM,
} from "../projectStorePaths.js";

const BASE = path.resolve("/test/config/projects");

describe("projectStorePaths", () => {
  describe("file path builders", () => {
    const validId = "a".repeat(64);

    it("stateFilePath returns correct path for valid ID", () => {
      const result = stateFilePath(BASE, validId);
      expect(result).toBe(path.join(BASE, validId, "state.json"));
    });

    it("settingsFilePath returns correct path for valid ID", () => {
      const result = settingsFilePath(BASE, validId);
      expect(result).toBe(path.join(BASE, validId, "settings.json"));
    });

    it("recipesFilePath returns correct path for valid ID", () => {
      const result = recipesFilePath(BASE, validId);
      expect(result).toBe(path.join(BASE, validId, "recipes.json"));
    });

    it("all return null for invalid ID", () => {
      expect(stateFilePath(BASE, "invalid")).toBeNull();
      expect(settingsFilePath(BASE, "invalid")).toBeNull();
      expect(recipesFilePath(BASE, "invalid")).toBeNull();
    });
  });

  describe("UTF8_BOM constant", () => {
    it("is the correct BOM character", () => {
      expect(UTF8_BOM).toBe("\uFEFF");
    });
  });
});
