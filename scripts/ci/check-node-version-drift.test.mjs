import { describe, it, expect } from "vitest";
import {
  parseExactPin,
  parseNodeEngineRange,
  findNodeVersionDrift,
} from "./check-node-version-drift.mjs";

describe("check-node-version-drift", () => {
  describe("parseExactPin", () => {
    it("parses a bare exact version", () => {
      expect(parseExactPin("22.13.0", ".nvmrc")).toBe("22.13.0");
    });

    it("tolerates a trailing newline (the normal on-disk shape)", () => {
      expect(parseExactPin("22.13.0\n", ".nvmrc")).toBe("22.13.0");
    });

    it("tolerates surrounding whitespace and CRLF", () => {
      expect(parseExactPin("  22.13.0\r\n", ".node-version")).toBe("22.13.0");
    });

    it("normalizes an optional leading v prefix", () => {
      expect(parseExactPin("v22.13.0\n", ".nvmrc")).toBe("22.13.0");
    });

    it("throws on an empty file", () => {
      expect(() => parseExactPin("\n", ".node-version")).toThrow(/is empty/);
    });

    it("throws on a partial version", () => {
      expect(() => parseExactPin("22.13", ".nvmrc")).toThrow(/not an exact x\.y\.z/);
    });

    it("throws on a range", () => {
      expect(() => parseExactPin(">=22.13.0", ".nvmrc")).toThrow(/not an exact x\.y\.z/);
    });

    it("throws on a caret range", () => {
      expect(() => parseExactPin("^22.13.0", ".nvmrc")).toThrow(/not an exact x\.y\.z/);
    });

    it("throws on an lts alias", () => {
      expect(() => parseExactPin("lts/*", ".nvmrc")).toThrow(
        /single bare version|not an exact x\.y\.z/
      );
    });

    it("throws on an inline comment (extra whitespace-separated token)", () => {
      expect(() => parseExactPin("22.13.0 # pinned", ".nvmrc")).toThrow(/single bare version/);
    });

    it("throws on multiple non-empty lines", () => {
      expect(() => parseExactPin("22.13.0\n22.14.0\n", ".nvmrc")).toThrow(/single bare version/);
    });

    // A drift guard must not let `semver` normalize textually-different pins to
    // the same value — each of these would otherwise collapse to "22.13.0".
    it("throws on build metadata (semver would strip it)", () => {
      expect(() => parseExactPin("22.13.0+local.1\n", ".nvmrc")).toThrow(/not an exact x\.y\.z/);
    });

    it("throws on a prerelease pin", () => {
      expect(() => parseExactPin("22.13.0-rc.1\n", ".nvmrc")).toThrow(/not an exact x\.y\.z/);
    });

    it("throws on a double v prefix (semver.valid tolerates a leading v)", () => {
      expect(() => parseExactPin("vv22.13.0\n", ".nvmrc")).toThrow(/not an exact x\.y\.z/);
    });

    it("throws on a leading zero segment", () => {
      expect(() => parseExactPin("22.013.0\n", ".nvmrc")).toThrow(/not an exact x\.y\.z/);
    });

    it("throws on a leading byte-order mark (breaks nvm/fnm parsing)", () => {
      expect(() => parseExactPin("﻿22.13.0\n", ".nvmrc")).toThrow(/byte-order mark/);
    });

    it("includes the label in the error message", () => {
      expect(() => parseExactPin("nope", ".node-version")).toThrow(/\.node-version/);
    });
  });

  describe("parseNodeEngineRange", () => {
    it("extracts the minimum from an open floor range", () => {
      expect(parseNodeEngineRange('{"engines":{"node":">=22.13.0"}}')).toEqual({
        range: ">=22.13.0",
        minimum: "22.13.0",
      });
    });

    it("handles a bounded range", () => {
      expect(parseNodeEngineRange('{"engines":{"node":">=22.13.0 <23"}}').minimum).toBe("22.13.0");
    });

    it("handles a caret range", () => {
      expect(parseNodeEngineRange('{"engines":{"node":"^22.13.0"}}').minimum).toBe("22.13.0");
    });

    it("resolves an exclusive lower bound to the next patch", () => {
      // semver.minVersion(">22.13.0") is 22.13.1 — the smallest satisfying version.
      expect(parseNodeEngineRange('{"engines":{"node":">22.13.0"}}').minimum).toBe("22.13.1");
    });

    it("throws on malformed JSON", () => {
      expect(() => parseNodeEngineRange("{ not json")).toThrow(/not valid JSON/);
    });

    it("throws when engines.node is missing", () => {
      expect(() => parseNodeEngineRange('{"engines":{}}')).toThrow(/must be a non-empty string/);
    });

    it("throws when engines is absent entirely", () => {
      expect(() => parseNodeEngineRange('{"name":"x"}')).toThrow(/must be a non-empty string/);
    });

    it("throws when engines.node is not a string", () => {
      expect(() => parseNodeEngineRange('{"engines":{"node":22}}')).toThrow(
        /must be a non-empty string/
      );
    });

    it("throws when engines.node is whitespace only", () => {
      expect(() => parseNodeEngineRange('{"engines":{"node":" \\t "}}')).toThrow(
        /must be a non-empty string/
      );
    });

    it("resolves an unbounded floor to 0.0.0 rather than null", () => {
      // Locks the semver interpretation: ">=0" is satisfiable (min 0.0.0), unlike
      // "<0.0.0" which is not — the guard must treat these differently.
      expect(parseNodeEngineRange('{"engines":{"node":">=0"}}').minimum).toBe("0.0.0");
    });

    it("throws on an invalid range", () => {
      expect(() => parseNodeEngineRange('{"engines":{"node":"not-a-range"}}')).toThrow(
        /not a valid semver range/
      );
    });

    it("throws on a range with no satisfiable minimum", () => {
      expect(() => parseNodeEngineRange('{"engines":{"node":"<0.0.0"}}')).toThrow(
        /no satisfiable minimum/
      );
    });
  });

  describe("findNodeVersionDrift", () => {
    const engineRange = ">=22.13.0";
    const engineMinimum = "22.13.0";

    it("passes when all three sources agree", () => {
      const result = findNodeVersionDrift({
        nvmrcVersion: "22.13.0",
        nodeVersionFile: "22.13.0",
        engineRange,
        engineMinimum,
      });
      expect(result).toEqual({ ok: true, failures: [] });
    });

    it("flags .node-version when it is stale below the floor (the #11122 bug)", () => {
      const result = findNodeVersionDrift({
        nvmrcVersion: "22.13.0",
        nodeVersionFile: "22.12.0",
        engineRange,
        engineMinimum,
      });
      expect(result.ok).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].file).toMatch(/\.node-version$/);
      expect(result.failures[0].message).toContain("22.12.0");
    });

    it("flags .nvmrc when it alone drifts", () => {
      const result = findNodeVersionDrift({
        nvmrcVersion: "22.14.0",
        nodeVersionFile: "22.13.0",
        engineRange,
        engineMinimum,
      });
      expect(result.ok).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].file).toMatch(/\.nvmrc$/);
    });

    it("flags both pins when they drift upward together above a stale engine floor", () => {
      // The case a plain "satisfies the range" check would wrongly pass.
      const result = findNodeVersionDrift({
        nvmrcVersion: "22.14.0",
        nodeVersionFile: "22.14.0",
        engineRange,
        engineMinimum,
      });
      expect(result.ok).toBe(false);
      expect(result.failures).toHaveLength(2);
    });
  });
});
