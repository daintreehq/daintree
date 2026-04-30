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
  });

  describe("unknown kind", () => {
    it("returns undefined for unregistered kind", () => {
      expect(getDeserializer("terminal")).toBeUndefined();
      expect(getDeserializer("agent")).toBeUndefined();
      expect(getDeserializer("custom-ext")).toBeUndefined();
    });
  });
});
