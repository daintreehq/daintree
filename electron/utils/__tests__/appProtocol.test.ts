import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveAppUrlToDistPath, getMimeType, buildHeaders } from "../appProtocol.js";

describe("appProtocol utilities", () => {
  describe("getMimeType", () => {
    it("should return correct MIME type for known extensions", () => {
      expect(getMimeType("index.html")).toBe("text/html");
      expect(getMimeType("app.js")).toBe("text/javascript");
      expect(getMimeType("styles.css")).toBe("text/css");
      expect(getMimeType("data.json")).toBe("application/json");
      expect(getMimeType("image.png")).toBe("image/png");
      expect(getMimeType("photo.jpg")).toBe("image/jpeg");
      expect(getMimeType("icon.svg")).toBe("image/svg+xml");
      expect(getMimeType("module.wasm")).toBe("application/wasm");
    });

    it("should return default MIME type for unknown extensions", () => {
      expect(getMimeType("file.xyz")).toBe("application/octet-stream");
      expect(getMimeType("noext")).toBe("application/octet-stream");
    });

    it("should handle uppercase extensions", () => {
      expect(getMimeType("FILE.HTML")).toBe("text/html");
      expect(getMimeType("APP.JS")).toBe("text/javascript");
    });
  });

  describe("buildHeaders", () => {
    it("should return headers with correct COOP/COEP values", () => {
      const headers = buildHeaders("text/html");
      expect(headers["Content-Type"]).toBe("text/html");
      expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
      expect(headers["Cross-Origin-Embedder-Policy"]).toBe("credentialless");
    });

    it("should accept any MIME type", () => {
      const headers = buildHeaders("application/json");
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });

  describe("resolveAppUrlToDistPath", () => {
    const distRoot = path.resolve("/fake/dist");

    it("should resolve root path to index.html", () => {
      const result = resolveAppUrlToDistPath("app://canopy/", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "index.html"));
    });

    it("should resolve empty path to index.html", () => {
      const result = resolveAppUrlToDistPath("app://canopy", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "index.html"));
    });

    it("should resolve file paths correctly", () => {
      const result = resolveAppUrlToDistPath("app://canopy/assets/app.js", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "assets", "app.js"));
    });

    it("should handle URL encoding", () => {
      const result = resolveAppUrlToDistPath("app://canopy/path%20with%20spaces/file.js", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "path with spaces", "file.js"));
    });

    it("should handle path segments with .. (URL normalizes before reaching resolver)", () => {
      const result = resolveAppUrlToDistPath("app://canopy/../secret.txt", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "secret.txt"));
    });

    it("should handle nested path segments with .. (URL normalizes)", () => {
      const result = resolveAppUrlToDistPath("app://canopy/nested/../../outside.txt", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "outside.txt"));
    });

    it("should reject non-app:// protocol", () => {
      const result = resolveAppUrlToDistPath("http://canopy/index.html", distRoot);
      expect(result.error).toBe("Invalid protocol");
      expect(result.filePath).toBe("");
    });

    it("should handle malformed URLs gracefully", () => {
      const result = resolveAppUrlToDistPath("not-a-url", distRoot);
      expect(result.error).toBeDefined();
      expect(result.filePath).toBe("");
    });

    it("should resolve nested paths correctly", () => {
      const result = resolveAppUrlToDistPath("app://canopy/assets/images/logo.png", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "assets", "images", "logo.png"));
    });

    it("should handle paths with leading slash", () => {
      const result = resolveAppUrlToDistPath("app://canopy/app.js", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "app.js"));
    });

    it("should handle encoded dot segments (URL normalizes %2e%2e before resolver)", () => {
      const result = resolveAppUrlToDistPath("app://canopy/%2e%2e/secret.txt", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "secret.txt"));
    });

    it("should handle encoded absolute paths safely (URL preserves %2F encoding)", () => {
      const result = resolveAppUrlToDistPath("app://canopy/%2Fetc%2Fpasswd", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "etc", "passwd"));
    });

    it("should reject paths with null bytes", () => {
      const result = resolveAppUrlToDistPath("app://canopy/file%00.txt", distRoot);
      expect(result.error).toBe("Invalid path");
      expect(result.filePath).toBe("");
    });

    it("should reject paths with backslashes", () => {
      const result = resolveAppUrlToDistPath("app://canopy/path\\file.txt", distRoot);
      expect(result.error).toBe("Invalid path separator");
      expect(result.filePath).toBe("");
    });

    it("should ignore query strings and hashes", () => {
      const result = resolveAppUrlToDistPath("app://canopy/app.js?v=123#anchor", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "app.js"));
    });

    it("should validate hostname when expectedHostname option is provided", () => {
      const result = resolveAppUrlToDistPath("app://canopy/index.html", distRoot, {
        expectedHostname: "canopy",
      });
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "index.html"));
    });

    it("should reject incorrect hostname when expectedHostname option is provided", () => {
      const result = resolveAppUrlToDistPath("app://wrong/index.html", distRoot, {
        expectedHostname: "canopy",
      });
      expect(result.error).toBe("Invalid host");
      expect(result.filePath).toBe("");
    });
  });
});
