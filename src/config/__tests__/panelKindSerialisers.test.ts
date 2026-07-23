import { describe, it, expect } from "vitest";
import { getDeserializer } from "../panelKindSerialisers";

describe("panelKindSerialisers", () => {
  describe("browser", () => {
    it("extracts browser fields", () => {
      const deserialize = getDeserializer("browser");
      const result = deserialize!({
        id: "b1",
        browserUrl: "https://example.com",
        browserHistory: { past: [], present: "", future: [] },
        browserZoom: 1.5,
        browserConsoleOpen: true,
      });
      expect(result).toEqual({
        browserUrl: "https://example.com",
        browserHistory: { past: [], present: "", future: [] },
        browserZoom: 1.5,
        browserConsoleOpen: true,
      });
    });

    it("returns undefined for missing optional fields", () => {
      const deserialize = getDeserializer("browser");
      const result = deserialize!({ id: "b1" });
      expect(result.browserUrl).toBeUndefined();
      expect(result.browserConsoleOpen).toBeUndefined();
    });
  });

  describe("dev-preview", () => {
    it("extracts dev-preview fields", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({
        id: "d1",
        devCommand: "npm run dev",
        browserUrl: "http://localhost:5173",
        browserZoom: 1.0,
        devPreviewConsoleOpen: true,
        createdAt: 100,
      });
      expect(result).toEqual({
        devCommand: "npm run dev",
        browserUrl: "http://localhost:5173",
        browserZoom: 1.0,
        devPreviewConsoleOpen: true,
        createdAt: 100,
        browserHistory: undefined,
        viewportPreset: undefined,
        viewportRotated: false,
        viewportDpr: 1,
        viewportFit: false,
        devPreviewScrollPosition: undefined,
      });
    });

    it("falls back from devCommand to command", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({ id: "d1", command: "  npm start  " });
      expect(result.devCommand).toBe("npm start");
    });

    it("returns undefined devCommand when both missing", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({ id: "d1" });
      expect(result.devCommand).toBeUndefined();
    });

    it("keeps a known viewportPreset and round-trips emulation fields", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({
        id: "d1",
        viewportPreset: "ipad",
        viewportRotated: true,
        viewportDpr: 2,
        viewportFit: true,
      });
      expect(result.viewportPreset).toBe("ipad");
      expect(result.viewportRotated).toBe(true);
      expect(result.viewportDpr).toBe(2);
      expect(result.viewportFit).toBe(true);
    });

    it("drops a stale/unknown viewportPreset id instead of resurrecting it", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({ id: "d1", viewportPreset: "nokia" });
      expect(result.viewportPreset).toBeUndefined();
    });

    it("clamps an out-of-range persisted viewportDpr to 1", () => {
      const deserialize = getDeserializer("dev-preview");
      const result = deserialize!({
        id: "d1",
        viewportDpr: 5 as unknown as 1 | 2 | 3,
      });
      expect(result.viewportDpr).toBe(1);
    });
  });

  describe("file-browser", () => {
    const deserialize = () => getDeserializer("file-browser")!;

    it("keeps safe relative paths and drops everything that could escape the root", () => {
      const result = deserialize()({
        id: "fb1",
        browserExpandedPaths: [
          "src",
          "src/lib",
          "/etc",
          "../secrets",
          "a/../../b",
          "..\\..\\windows",
          "C:\\Users",
          "\\\\server\\share",
          "",
          42,
          null,
          { nope: true },
        ],
      });

      expect(result.browserExpandedPaths).toEqual(["src", "src/lib"]);
    });

    it("rejects traversal written with backslashes, not just forward slashes", () => {
      // A snapshot written on Windows can be opened on POSIX and vice versa, so
      // the sanitizer can't assume one separator convention.
      const result = deserialize()({
        id: "fb1",
        browserExpandedPaths: ["ok", "nested\\..\\..\\escape"],
      });

      expect(result.browserExpandedPaths).toEqual(["ok"]);
    });

    it("deduplicates and caps a pathological expansion list", () => {
      const huge = Array.from({ length: 5000 }, (_, index) => `dir-${index % 900}`);

      const result = deserialize()({ id: "fb1", browserExpandedPaths: huge });
      const restored = result.browserExpandedPaths ?? [];

      // Every surviving entry becomes a directory the browser re-lists on each
      // refresh, so this is a work bound rather than a cosmetic one.
      expect(restored.length).toBeLessThanOrEqual(500);
      expect(new Set(restored).size).toBe(restored.length);
    });

    it("preserves a legitimately empty expansion list", () => {
      // "The user had nothing expanded" is a real state, distinct from "this
      // panel predates the field".
      expect(deserialize()({ id: "fb1", browserExpandedPaths: [] }).browserExpandedPaths).toEqual(
        []
      );
    });

    it("returns undefined when the persisted value is not a list at all", () => {
      expect(
        deserialize()({ id: "fb1", browserExpandedPaths: "src" }).browserExpandedPaths
      ).toBeUndefined();
    });

    it("drops a non-string selected path rather than handing the pane an object", () => {
      // The snapshot schema passes unknown keys through, so this shape survives
      // main-process validation and would be `.split("/")` by the pane.
      expect(
        deserialize()({ id: "fb1", browserSelectedPath: {} }).browserSelectedPath
      ).toBeUndefined();
      expect(
        deserialize()({ id: "fb1", browserSelectedPath: "../escape" }).browserSelectedPath
      ).toBeUndefined();
      expect(
        deserialize()({ id: "fb1", browserSelectedPath: "src/app.ts" }).browserSelectedPath
      ).toBe("src/app.ts");
    });

    it("drops a non-boolean ignored toggle rather than coercing it", () => {
      expect(
        deserialize()({ id: "fb1", browserShowIgnored: "yes" }).browserShowIgnored
      ).toBeUndefined();
      expect(deserialize()({ id: "fb1", browserShowIgnored: false }).browserShowIgnored).toBe(
        false
      );
    });

    it("restores a collapsed sidebar only from a literal true", () => {
      // Only `true` collapses; `false` and absent are the open default, and a
      // corrupted string/object must fall back to open rather than crash the pane.
      expect(
        deserialize()({ id: "fb1", browserSidebarCollapsed: true }).browserSidebarCollapsed
      ).toBe(true);
      expect(
        deserialize()({ id: "fb1", browserSidebarCollapsed: false }).browserSidebarCollapsed
      ).toBeUndefined();
      expect(
        deserialize()({ id: "fb1", browserSidebarCollapsed: "yes" }).browserSidebarCollapsed
      ).toBeUndefined();
      expect(deserialize()({ id: "fb1" }).browserSidebarCollapsed).toBeUndefined();
    });
  });

  describe("unknown kind", () => {
    it("returns undefined for unregistered kind", () => {
      expect(getDeserializer("terminal")).toBeUndefined();
      expect(getDeserializer("agent")).toBeUndefined();
      expect(getDeserializer("custom-ext")).toBeUndefined();
    });
  });
});
