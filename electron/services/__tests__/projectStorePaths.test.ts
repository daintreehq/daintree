import { describe, it, expect } from "vitest";
import path from "path";
import { randomUUID } from "crypto";
import {
  stateFilePath,
  settingsFilePath,
  recipesFilePath,
  schedulesFilePath,
  isValidProjectId,
  isValidWorkspaceStateId,
  getProjectStateDir,
} from "../projectStorePaths.js";
import { isValidScratchId } from "../scratchStorePaths.js";

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
      expect(schedulesFilePath(BASE, "invalid")).toBeNull();
    });

    it("schedulesFilePath sits in a project's state directory, never a scratch's", () => {
      expect(schedulesFilePath(BASE, validId)).toBe(path.join(BASE, validId, "schedules.json"));
      const scratchId = randomUUID();
      expect(getProjectStateDir(BASE, scratchId)).not.toBeNull();
      expect(schedulesFilePath(BASE, scratchId)).toBeNull();
    });
  });

  describe("workspace state ids (#11484)", () => {
    it("accepts a scratch id as a state-directory owner", () => {
      const scratchId = randomUUID();
      const dir = getProjectStateDir(BASE, scratchId);

      expect(dir).toBe(path.join(BASE, scratchId));
      expect(stateFilePath(BASE, scratchId)).toBe(path.join(BASE, scratchId, "state.json"));
    });

    it("keeps the project and scratch id spaces disjoint", () => {
      const scratchId = randomUUID();
      const projectId = "a".repeat(64);

      expect(isValidProjectId(scratchId)).toBe(false);
      expect(isValidScratchId(projectId)).toBe(false);
    });

    it("admits exactly the union of the two id shapes", () => {
      const samples = [
        ...Array.from({ length: 20 }, () => randomUUID()),
        "a".repeat(64),
        "0123456789abcdef".repeat(4),
        randomUUID().toUpperCase(),
        randomUUID().replace(/-/g, ""),
        "a".repeat(63),
        "a".repeat(65),
        "",
        "..",
        "../escape",
      ];

      for (const sample of samples) {
        expect(isValidWorkspaceStateId(sample)).toBe(
          isValidProjectId(sample) || isValidScratchId(sample)
        );
      }
    });

    it("still rejects ids that could escape the state root", () => {
      const escapes = ["..", "../escape", `..${path.sep}escape`, "./nested", "a/b"];

      for (const escape of escapes) {
        expect(getProjectStateDir(BASE, escape)).toBeNull();
      }
    });
  });
});
