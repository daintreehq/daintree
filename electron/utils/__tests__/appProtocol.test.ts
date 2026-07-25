import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  resolveAppUrlToDistPath,
  getMimeType,
  buildHeaders,
  isImmutableAppAsset,
  isNotModified,
  toHttpDate,
} from "../appProtocol.js";
import { DAINTREE_APP_PERMISSIONS_POLICY } from "../../../shared/config/permissionsPolicy.js";

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
      expect(getMimeType("photo.webp")).toBe("image/webp");
      expect(getMimeType("image.bmp")).toBe("image/bmp");
      expect(getMimeType("hero.avif")).toBe("image/avif");
    });

    it("maps APNG to its own image type rather than the octet-stream fallback", () => {
      // An .apng is a valid PNG, but nosniff on daintree-file:// means the
      // declared type is final: falling back to application/octet-stream would
      // stop Chromium decoding it in an <img> even though it can animate it.
      expect(getMimeType("animation.apng")).toBe("image/apng");
      expect(getMimeType("ANIMATION.APNG")).toBe("image/apng");
      expect(getMimeType("PHOTO.AVIF")).toBe("image/avif");
    });

    it("should return video MIME types for containers Chromium plays natively", () => {
      // Drives the daintree-file:// handler's video-vs-buffered routing AND the
      // Content-Type on streamed responses — nosniff makes a wrong type fatal.
      expect(getMimeType("clip.mp4")).toBe("video/mp4");
      expect(getMimeType("clip.m4v")).toBe("video/mp4");
      expect(getMimeType("clip.webm")).toBe("video/webm");
      expect(getMimeType("clip.ogv")).toBe("video/ogg");
      expect(getMimeType("CLIP.MP4")).toBe("video/mp4");
    });

    it("should not map containers Chromium can't demux to a video MIME", () => {
      // mov/mkv/avi/wmv are excluded from the playable set — mapping them to
      // video/* would route them into the streaming path and a broken <video>.
      expect(getMimeType("clip.mov")).toBe("application/octet-stream");
      expect(getMimeType("clip.mkv")).toBe("application/octet-stream");
      expect(getMimeType("clip.avi")).toBe("application/octet-stream");
      expect(getMimeType("clip.wmv")).toBe("application/octet-stream");
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
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
      expect(headers["Permissions-Policy"]).toBe(DAINTREE_APP_PERMISSIONS_POLICY);
      expect(headers["Permissions-Policy"]).toContain("microphone=(self)");
      expect(headers["Permissions-Policy"]).toContain("camera=()");
      expect(headers["Permissions-Policy"]).toContain("geolocation=()");
    });

    it("should include Permissions-Policy header on all MIME types", () => {
      const mimeTypes = ["text/html", "text/javascript", "text/css", "application/json"];
      for (const mime of mimeTypes) {
        const headers = buildHeaders(mime);
        expect(headers["Permissions-Policy"]).toBe(DAINTREE_APP_PERMISSIONS_POLICY);
      }
    });

    it("should accept any MIME type", () => {
      const headers = buildHeaders("application/json");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("emits a revalidating Cache-Control by default (never no-store)", () => {
      const headers = buildHeaders("text/html");
      expect(headers["Cache-Control"]).toBe("no-cache, must-revalidate");
      expect(headers["Cache-Control"]).not.toContain("no-store");
    });

    it("omits Last-Modified when no stats are provided", () => {
      const headers = buildHeaders("text/html");
      expect(headers["Last-Modified"]).toBeUndefined();
    });

    it("emits Last-Modified in RFC 7231 GMT format when stats are provided", () => {
      const mtime = new Date("2025-06-03T12:34:56.789Z");
      const headers = buildHeaders("text/html", {
        stats: { mtime },
        filePath: "index.html",
      });
      expect(headers["Last-Modified"]).toBe("Tue, 03 Jun 2025 12:34:56 GMT");
    });

    it("emits an immutable Cache-Control for content-hashed Vite assets", () => {
      const headers = buildHeaders("text/javascript", {
        stats: { mtime: new Date() },
        filePath: path.join("dist", "assets", "app-a1b2c3d4.js"),
      });
      expect(headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    });

    it("emits an immutable Cache-Control for content-hashed CSS", () => {
      const headers = buildHeaders("text/css", {
        stats: { mtime: new Date() },
        filePath: "dist/assets/styles-A1b2C3d4.css",
      });
      expect(headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    });

    it("emits a revalidating Cache-Control for index.html (not content-hashed)", () => {
      const headers = buildHeaders("text/html", {
        stats: { mtime: new Date() },
        filePath: "dist/index.html",
      });
      expect(headers["Cache-Control"]).toBe("no-cache, must-revalidate");
    });

    it("emits a revalidating Cache-Control for unhashed files in dist root", () => {
      const headers = buildHeaders("text/javascript", {
        stats: { mtime: new Date() },
        filePath: "dist/sw.js",
      });
      expect(headers["Cache-Control"]).toBe("no-cache, must-revalidate");
    });

    it("always emits Last-Modified when stats are provided (304 path contract)", () => {
      const mtime = new Date("2025-06-03T12:34:56Z");
      const variants = [
        buildHeaders("text/html", { stats: { mtime }, filePath: "index.html" }),
        buildHeaders("text/javascript", {
          stats: { mtime },
          filePath: "dist/assets/app-12345678.js",
        }),
        buildHeaders("text/css", {
          stats: { mtime },
          filePath: "dist/assets/styles-12345678.css",
        }),
      ];
      for (const headers of variants) {
        expect(headers["Last-Modified"]).toBe("Tue, 03 Jun 2025 12:34:56 GMT");
      }
    });

    it("preserves the full security header set on every variant", () => {
      const variants = [
        buildHeaders("text/plain"),
        buildHeaders("text/html", { stats: { mtime: new Date() }, filePath: "index.html" }),
        buildHeaders("text/javascript", {
          stats: { mtime: new Date() },
          filePath: "dist/assets/app-12345678.js",
        }),
      ];
      for (const headers of variants) {
        expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
        expect(headers["Cross-Origin-Embedder-Policy"]).toBe("credentialless");
        expect(headers["Permissions-Policy"]).toBe(DAINTREE_APP_PERMISSIONS_POLICY);
        expect(headers["X-Content-Type-Options"]).toBe("nosniff");
        expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
        expect(headers["Cache-Control"]).not.toContain("no-store");
      }
    });
  });

  describe("isImmutableAppAsset", () => {
    it("matches Vite content-hashed JS chunks under assets/", () => {
      expect(isImmutableAppAsset("dist/assets/app-a1b2c3d4.js")).toBe(true);
      expect(isImmutableAppAsset("dist/assets/vendor-react-12345678.js")).toBe(true);
      expect(isImmutableAppAsset("dist/assets/index-aBcDeFgH.mjs")).toBe(true);
    });

    it("matches Vite content-hashed CSS chunks under assets/", () => {
      expect(isImmutableAppAsset("dist/assets/index-12345678.css")).toBe(true);
    });

    it("matches content-hashed AVIF images (paired with image/avif MIME)", () => {
      expect(isImmutableAppAsset("dist/assets/hero-a1b2c3d4.avif")).toBe(true);
    });

    it("matches base64url hash characters (underscore, hyphen)", () => {
      expect(isImmutableAppAsset("dist/assets/app-aB_d-FgH.js")).toBe(true);
    });

    it("matches longer hashes (>=8 chars)", () => {
      expect(isImmutableAppAsset("dist/assets/app-a1b2c3d4e5f6.js")).toBe(true);
    });

    it("matches Windows-style backslash paths", () => {
      expect(isImmutableAppAsset("dist\\assets\\app-a1b2c3d4.js")).toBe(true);
    });

    it("does not match index.html at the dist root", () => {
      expect(isImmutableAppAsset("dist/index.html")).toBe(false);
    });

    it("does not match unhashed files in assets/", () => {
      expect(isImmutableAppAsset("dist/assets/app.js")).toBe(false);
      expect(isImmutableAppAsset("dist/assets/logo.svg")).toBe(false);
    });

    it("does not match files with a too-short hash", () => {
      expect(isImmutableAppAsset("dist/assets/app-abc12.js")).toBe(false);
    });

    it("does not match files outside the assets/ directory", () => {
      expect(isImmutableAppAsset("dist/sw-12345678.js")).toBe(false);
      expect(isImmutableAppAsset("dist/nested/file-12345678.js")).toBe(false);
    });

    it("does not match nested paths under assets/ (Vite output is flat)", () => {
      expect(isImmutableAppAsset("dist/assets/sub/file-12345678.js")).toBe(false);
    });
  });

  describe("toHttpDate", () => {
    it("formats dates in RFC 7231 IMF-fixdate (second precision, GMT)", () => {
      expect(toHttpDate(new Date("2025-01-01T00:00:00Z"))).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
      expect(toHttpDate(new Date("2025-06-03T12:34:56.789Z"))).toBe(
        "Tue, 03 Jun 2025 12:34:56 GMT"
      );
    });
  });

  describe("isNotModified", () => {
    const mtime = new Date("2025-06-03T12:34:56.000Z");

    it("returns false when the header is null", () => {
      expect(isNotModified(null, mtime)).toBe(false);
    });

    it("returns false when the header is malformed", () => {
      expect(isNotModified("not-a-date", mtime)).toBe(false);
    });

    it("returns true when the client date equals mtime", () => {
      expect(isNotModified("Tue, 03 Jun 2025 12:34:56 GMT", mtime)).toBe(true);
    });

    it("returns true when the client date is newer than mtime", () => {
      expect(isNotModified("Wed, 04 Jun 2025 00:00:00 GMT", mtime)).toBe(true);
    });

    it("returns false when mtime is newer than the client date", () => {
      expect(isNotModified("Tue, 03 Jun 2025 12:34:55 GMT", mtime)).toBe(false);
    });

    it("normalizes sub-second mtime to seconds (matches header second-precision)", () => {
      const subSecondMtime = new Date("2025-06-03T12:34:56.700Z");
      expect(isNotModified("Tue, 03 Jun 2025 12:34:56 GMT", subSecondMtime)).toBe(true);
    });

    it("returns false on an empty string header", () => {
      expect(isNotModified("", mtime)).toBe(false);
    });
  });

  describe("resolveAppUrlToDistPath", () => {
    const distRoot = path.resolve("/fake/dist");

    it("should resolve root path to index.html", () => {
      const result = resolveAppUrlToDistPath("app://daintree/", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "index.html"));
    });

    it("should resolve empty path to index.html", () => {
      const result = resolveAppUrlToDistPath("app://daintree", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "index.html"));
    });

    it("should resolve file paths correctly", () => {
      const result = resolveAppUrlToDistPath("app://daintree/assets/app.js", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "assets", "app.js"));
    });

    it("should handle URL encoding", () => {
      const result = resolveAppUrlToDistPath(
        "app://daintree/path%20with%20spaces/file.js",
        distRoot
      );
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "path with spaces", "file.js"));
    });

    it("should handle path segments with .. (URL normalizes before reaching resolver)", () => {
      const result = resolveAppUrlToDistPath("app://daintree/../secret.txt", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "secret.txt"));
    });

    it("should handle nested path segments with .. (URL normalizes)", () => {
      const result = resolveAppUrlToDistPath("app://daintree/nested/../../outside.txt", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "outside.txt"));
    });

    it("should reject non-app:// protocol", () => {
      const result = resolveAppUrlToDistPath("http://daintree/index.html", distRoot);
      expect(result.error).toBe("Invalid protocol");
      expect(result.filePath).toBe("");
    });

    it("should handle malformed URLs gracefully", () => {
      const result = resolveAppUrlToDistPath("not-a-url", distRoot);
      expect(result.error).toBeDefined();
      expect(result.filePath).toBe("");
    });

    it("should resolve nested paths correctly", () => {
      const result = resolveAppUrlToDistPath("app://daintree/assets/images/logo.png", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "assets", "images", "logo.png"));
    });

    it("should handle paths with leading slash", () => {
      const result = resolveAppUrlToDistPath("app://daintree/app.js", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "app.js"));
    });

    it("should handle encoded dot segments (URL normalizes %2e%2e before resolver)", () => {
      const result = resolveAppUrlToDistPath("app://daintree/%2e%2e/secret.txt", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "secret.txt"));
    });

    it("should handle encoded absolute paths safely (URL preserves %2F encoding)", () => {
      const result = resolveAppUrlToDistPath("app://daintree/%2Fetc%2Fpasswd", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "etc", "passwd"));
    });

    it("should reject paths with null bytes", () => {
      const result = resolveAppUrlToDistPath("app://daintree/file%00.txt", distRoot);
      expect(result.error).toBe("Invalid path");
      expect(result.filePath).toBe("");
    });

    it("should reject paths with backslashes", () => {
      const result = resolveAppUrlToDistPath("app://daintree/path\\file.txt", distRoot);
      expect(result.error).toBe("Invalid path separator");
      expect(result.filePath).toBe("");
    });

    it("should ignore query strings and hashes", () => {
      const result = resolveAppUrlToDistPath("app://daintree/app.js?v=123#anchor", distRoot);
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "app.js"));
    });

    it("should validate hostname when expectedHostname option is provided", () => {
      const result = resolveAppUrlToDistPath("app://daintree/index.html", distRoot, {
        expectedHostname: "daintree",
      });
      expect(result.error).toBeUndefined();
      expect(result.filePath).toBe(path.join(distRoot, "index.html"));
    });

    it("should reject incorrect hostname when expectedHostname option is provided", () => {
      const result = resolveAppUrlToDistPath("app://wrong/index.html", distRoot, {
        expectedHostname: "daintree",
      });
      expect(result.error).toBe("Invalid host");
      expect(result.filePath).toBe("");
    });
  });
});
