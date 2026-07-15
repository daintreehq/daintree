import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ALLOWED_PREFIXES,
  PLATFORMS,
  checkVersionMonotonic,
  extractVersion,
  resolvePlatforms,
  shouldSkipUpload,
  validatePrefix,
  writeSkipUploadOutput,
} from "./check-version-monotonic.mjs";

describe("check-version-monotonic", () => {
  describe("checkVersionMonotonic", () => {
    it("passes when new is strictly greater (patch)", () => {
      expect(checkVersionMonotonic("1.0.0", "1.0.1")).toEqual({ ok: true });
    });

    it("passes when new is strictly greater (minor)", () => {
      expect(checkVersionMonotonic("1.0.0", "1.1.0")).toEqual({ ok: true });
    });

    it("passes when new is strictly greater (major)", () => {
      expect(checkVersionMonotonic("1.5.7", "2.0.0")).toEqual({ ok: true });
    });

    it("skips when versions are equal (re-tag of an already-published version)", () => {
      expect(checkVersionMonotonic("1.0.0", "1.0.0")).toEqual({ ok: true, skip: true });
    });

    it("skips identical prerelease versions (re-tag of a published rc)", () => {
      expect(checkVersionMonotonic("1.0.0-rc.1", "1.0.0-rc.1")).toEqual({ ok: true, skip: true });
    });

    it("does NOT skip a build-metadata-only difference — never actually published, fails closed", () => {
      // semver.eq would treat these as equal (build metadata is ignored for
      // precedence), but 1.0.0+b was never the live artifact. Exact identity
      // means it falls through to the strict-greater check and fails closed.
      const result = checkVersionMonotonic("1.0.0+a", "1.0.0+b");
      expect(result.ok).toBe(false);
      expect(result.skip).toBeUndefined();
      expect(result.error).toContain("not strictly greater");
    });

    it("fails when new is older", () => {
      const result = checkVersionMonotonic("1.0.0", "0.9.9");
      expect(result.ok).toBe(false);
      expect(result.skip).toBeUndefined();
      expect(result.error).toContain("not strictly greater");
    });

    it("passes when going from pre-release to release of the same version", () => {
      expect(checkVersionMonotonic("1.0.0-rc.1", "1.0.0")).toEqual({ ok: true });
    });

    it("passes for incremental rc bump", () => {
      expect(checkVersionMonotonic("1.0.0-rc.1", "1.0.0-rc.2")).toEqual({ ok: true });
    });

    it("passes when going from release to next pre-release", () => {
      expect(checkVersionMonotonic("1.0.0", "1.0.1-rc.1")).toEqual({ ok: true });
    });

    it("fails going from release to pre-release of same version (a downgrade, not a skip)", () => {
      const result = checkVersionMonotonic("1.0.0", "1.0.0-rc.1");
      expect(result.ok).toBe(false);
      expect(result.skip).toBeUndefined();
      expect(result.error).toContain("not strictly greater");
    });

    it("fails on invalid live version", () => {
      const result = checkVersionMonotonic("not-a-version", "1.0.0");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("live version");
      expect(result.error).toContain("not valid semver");
    });

    it("fails on invalid new version", () => {
      const result = checkVersionMonotonic("1.0.0", "garbage");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("new version");
      expect(result.error).toContain("not valid semver");
    });
  });

  describe("shouldSkipUpload", () => {
    it("skips only when every checked platform is already live and nothing failed", () => {
      expect(shouldSkipUpload(["mac"], ["mac"], [])).toBe(true);
      expect(shouldSkipUpload(["mac", "linux"], ["mac", "linux"], [])).toBe(true);
    });

    it("does not skip when only some platforms are already live (others need upload)", () => {
      expect(shouldSkipUpload(["mac", "linux"], ["mac"], [])).toBe(false);
    });

    it("does not skip when no platform is already live (a 404 first release / greater bump)", () => {
      expect(shouldSkipUpload(["mac", "linux"], [], [])).toBe(false);
    });

    it("does not skip when any platform failed, even alongside a skip", () => {
      expect(shouldSkipUpload(["mac"], [], ["mac: downgrade"])).toBe(false);
      expect(shouldSkipUpload(["mac", "linux"], ["linux"], ["mac: downgrade"])).toBe(false);
    });

    it("the failure veto is independent of the skip count (isolates failures.length === 0)", () => {
      // skipped.length === platforms.length here, so ONLY the zero-failures
      // clause can force false — this is the case that would regress if that
      // clause were ever dropped.
      expect(shouldSkipUpload(["mac"], ["mac"], ["mac: downgrade"])).toBe(false);
    });

    it("does not skip an empty platform set", () => {
      expect(shouldSkipUpload([], [], [])).toBe(false);
    });
  });

  describe("writeSkipUploadOutput", () => {
    const originalOutput = process.env.GITHUB_OUTPUT;
    let tmpDir;

    afterEach(() => {
      if (originalOutput === undefined) {
        delete process.env.GITHUB_OUTPUT;
      } else {
        process.env.GITHUB_OUTPUT = originalOutput;
      }
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
    });

    function useTmpOutput() {
      tmpDir = mkdtempSync(path.join(tmpdir(), "monotonic-out-"));
      const file = path.join(tmpDir, "github_output");
      process.env.GITHUB_OUTPUT = file;
      return file;
    }

    it("appends skip_upload=true, preserving any lines a prior step already wrote", () => {
      const file = useTmpOutput();
      // GITHUB_OUTPUT accumulates across a job — the write must APPEND, not
      // clobber (a writeFileSync swap would pass an empty-file assertion but
      // wipe another step's output).
      writeFileSync(file, "prior-step=1\n");
      writeSkipUploadOutput(true);
      expect(readFileSync(file, "utf8")).toBe("prior-step=1\nskip_upload=true\n");
    });

    it("appends skip_upload=false when not skipping", () => {
      const file = useTmpOutput();
      writeSkipUploadOutput(false);
      expect(readFileSync(file, "utf8")).toBe("skip_upload=false\n");
    });

    it("is a no-op when GITHUB_OUTPUT is unset (local / vitest runs)", () => {
      delete process.env.GITHUB_OUTPUT;
      expect(() => writeSkipUploadOutput(true)).not.toThrow();
    });

    it("throws (fail-closed) when GITHUB_OUTPUT points at an unwritable path", () => {
      // A set-but-broken output path must not be silently swallowed — the skip
      // decision would go uncommunicated and the gate should fail closed. The
      // missing parent is nested inside a fresh temp dir so it's guaranteed
      // absent (a predictable /tmp path could pre-exist and let the write land).
      tmpDir = mkdtempSync(path.join(tmpdir(), "monotonic-out-"));
      process.env.GITHUB_OUTPUT = path.join(tmpDir, "missing", "out");
      expect(() => writeSkipUploadOutput(true)).toThrow();
    });
  });

  describe("extractVersion", () => {
    it("returns the version string from a valid mapping", () => {
      expect(extractVersion({ version: "1.2.3" }, "test.yml")).toBe("1.2.3");
    });

    it("accepts pre-release strings", () => {
      expect(extractVersion({ version: "1.0.0-rc.4" }, "test.yml")).toBe("1.0.0-rc.4");
    });

    it("throws when input is null", () => {
      expect(() => extractVersion(null, "test.yml")).toThrow(/expected a YAML mapping/);
    });

    it("throws when input is a string instead of an object", () => {
      expect(() => extractVersion("hello", "test.yml")).toThrow(/expected a YAML mapping/);
    });

    it("throws when version field is missing", () => {
      expect(() => extractVersion({ files: [] }, "test.yml")).toThrow(/missing 'version' field/);
    });

    it("throws when version field is null", () => {
      expect(() => extractVersion({ version: null }, "test.yml")).toThrow(
        /missing 'version' field/
      );
    });

    it("throws when version field is a number (YAML-parsed bare numeric)", () => {
      expect(() => extractVersion({ version: 1 }, "test.yml")).toThrow(/must be a string/);
    });

    it("throws when version field is a boolean (YAML `version: true`)", () => {
      expect(() => extractVersion({ version: true }, "test.yml")).toThrow(/must be a string/);
    });

    it("throws when version field is an array (YAML sequence)", () => {
      expect(() => extractVersion({ version: ["1.0.0"] }, "test.yml")).toThrow(/must be a string/);
    });

    it("throws when version field is a nested object", () => {
      expect(() => extractVersion({ version: { major: 1 } }, "test.yml")).toThrow(
        /must be a string/
      );
    });

    it("throws when version field is a non-semver string", () => {
      expect(() => extractVersion({ version: "v1" }, "test.yml")).toThrow(/not a valid semver/);
    });

    it("throws when version field is an empty string", () => {
      expect(() => extractVersion({ version: "" }, "test.yml")).toThrow(/not a valid semver/);
    });

    it("includes the label in the error message", () => {
      expect(() => extractVersion({}, "live latest-mac.yml")).toThrow(/live latest-mac\.yml/);
    });
  });

  describe("validatePrefix", () => {
    it("accepts every prefix in ALLOWED_PREFIXES", () => {
      for (const prefix of ALLOWED_PREFIXES) {
        expect(validatePrefix(prefix)).toEqual({ ok: true });
      }
    });

    it("exposes the canonical channel allowlist", () => {
      // Lock the public surface — adding a channel should be a deliberate edit
      // (the upload step in release.yml uses the same prefix to glob YAMLs).
      expect(ALLOWED_PREFIXES).toEqual(["latest", "rc", "beta"]);
    });

    it("rejects an empty string with the not-set guidance", () => {
      const result = validatePrefix("");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not set");
      expect(result.error).toContain("latest");
    });

    it("rejects undefined with the not-set guidance", () => {
      const result = validatePrefix(undefined);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not set");
    });

    it("rejects a typo (latset) so the gate doesn't silently 404 every channel", () => {
      const result = validatePrefix("latset");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("'latset'");
      expect(result.error).toContain("not a known channel");
    });

    it("rejects nightly (channel was retired before the gate landed)", () => {
      const result = validatePrefix("nightly");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not a known channel");
    });
  });

  describe("resolvePlatforms", () => {
    it("defaults to all platforms when unset", () => {
      expect(resolvePlatforms(undefined)).toEqual({ ok: true, platforms: [...PLATFORMS] });
    });

    it("treats empty / whitespace as all platforms", () => {
      expect(resolvePlatforms("")).toEqual({ ok: true, platforms: [...PLATFORMS] });
      expect(resolvePlatforms("   ")).toEqual({ ok: true, platforms: [...PLATFORMS] });
    });

    it("scopes to a single platform", () => {
      expect(resolvePlatforms("mac")).toEqual({ ok: true, platforms: ["mac"] });
      expect(resolvePlatforms("win")).toEqual({ ok: true, platforms: ["win"] });
    });

    it("normalizes case and whitespace, dedupes, and preserves PLATFORMS order", () => {
      expect(resolvePlatforms(" WIN , mac , mac ")).toEqual({
        ok: true,
        platforms: ["mac", "win"],
      });
    });

    it("rejects an unknown platform so a typo can't silently skip the gate", () => {
      const result = resolvePlatforms("macos");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("macos");
      expect(result.error).toContain("mac, linux, win");
    });
  });
});
