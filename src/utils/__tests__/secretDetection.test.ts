import { describe, it, expect } from "vitest";
import { looksLikeSecret } from "../secretDetection";

describe("looksLikeSecret", () => {
  describe("safe-form bypass", () => {
    it.each([
      "${ANTHROPIC_API_KEY}",
      "${OPENAI_API_KEY}",
      "${GITHUB_TOKEN}",
      "${home}",
      "${myVar}",
      "${_PRIVATE_VAR}",
      "${A}",
    ])("returns false for %s", (value) => {
      expect(looksLikeSecret(value)).toBe(false);
    });
  });

  describe("named vendor patterns", () => {
    it.each([
      ["sk-ant-abcdefghijklmnopqrstuvwxyz123456", "Anthropic"],
      ["sk-ant-api03-" + "a".repeat(80), "Anthropic api03"],
      ["sk-abcdefghijklmnopqrstuvwx12345678", "OpenAI user"],
      ["sk-proj-abcdefghijklmnopqrstuvwx12345678", "OpenAI project"],
      ["ghp_" + "A".repeat(36), "GitHub personal"],
      ["gho_" + "B".repeat(36), "GitHub OAuth"],
      ["ghu_" + "C".repeat(36), "GitHub user"],
      ["ghs_" + "D".repeat(36), "GitHub server"],
      ["ghr_" + "E".repeat(36), "GitHub refresh"],
      [`github_pat_${"A".repeat(22)}_${"B".repeat(59)}`, "GitHub fine-grained PAT"],
      ["AKIAIOSFODNN7EXAMPLE", "AWS access key"],
      ["ak-" + "x".repeat(30), "Generic ak-"],
      ["sk-" + "y".repeat(30), "Generic sk-"],
      ["pk-" + "z".repeat(30), "Generic pk-"],
    ])("detects %s (%s)", (value) => {
      expect(looksLikeSecret(value)).toBe(true);
    });
  });

  describe("long opaque fallback", () => {
    it("detects a 40-char base64-ish string (spec threshold)", () => {
      expect(looksLikeSecret("A".repeat(40))).toBe(true);
    });

    it("detects a long base64+/= style token", () => {
      expect(looksLikeSecret("abcd1234+/=".repeat(5))).toBe(true);
    });

    it("does NOT flag a 39-char string (under threshold)", () => {
      expect(looksLikeSecret("A".repeat(39))).toBe(false);
    });
  });

  describe("named pattern boundary cases", () => {
    // Note: Anthropic's `sk-ant-...` body length boundary isn't independently
    // testable because any `sk-<20+ chars>` also matches the OpenAI pattern.
    // The OpenAI boundary below is the effective floor for all `sk-` prefixed
    // keys.

    it("requires at least 20 chars in OpenAI body", () => {
      expect(looksLikeSecret("sk-" + "a".repeat(19))).toBe(false);
      expect(looksLikeSecret("sk-" + "a".repeat(20))).toBe(true);
    });

    it("requires at least 24 chars in generic ak/sk/pk body", () => {
      // The OpenAI pattern matches at 20 chars, so test with a prefix that
      // only the generic pattern catches. At 23 chars body, the generic
      // pattern fails but OpenAI still matches (sk-). Use ak- to isolate.
      expect(looksLikeSecret("ak-" + "a".repeat(23))).toBe(false);
      expect(looksLikeSecret("ak-" + "a".repeat(24))).toBe(true);
    });

    it("requires exactly 16 chars in AWS AKIA body", () => {
      expect(looksLikeSecret("AKIA" + "A".repeat(15))).toBe(false);
      expect(looksLikeSecret("AKIA" + "A".repeat(16))).toBe(true);
      // 17 chars would fail anchor ($), but the fallback may catch it if
      // total length ≥ 40 — which it's not here.
      expect(looksLikeSecret("AKIA" + "A".repeat(17))).toBe(false);
    });
  });

  describe("non-secret values", () => {
    it.each([
      "",
      "hello",
      "localhost",
      "https://example.com/api",
      "8080",
      "/usr/local/bin",
      "true",
      "debug",
      // 36-char UUID — under the 48-char fallback threshold.
      "550e8400-e29b-41d4-a716-446655440000",
      // Short hex string.
      "abc123",
      // Contains a space — won't match any anchored pattern.
      "this is a long sentence typed by a user in a config",
    ])("returns false for %j", (value) => {
      expect(looksLikeSecret(value)).toBe(false);
    });
  });

  describe("boundary cases", () => {
    it("returns false for a safe-form value whose name would itself match a secret pattern", () => {
      // The name inside ${...} isn't a real secret; the wrapper makes it a reference.
      expect(looksLikeSecret("${SK_ANT_LOOKALIKE_KEY_NAME}")).toBe(false);
    });

    it("rejects AKIA-prefixed key with lowercase (real AWS keys are uppercase+digits)", () => {
      expect(looksLikeSecret("AKIAabcdefghijklmnop")).toBe(false);
    });

    it("rejects sk-ant with too-short body", () => {
      expect(looksLikeSecret("sk-ant-short")).toBe(false);
    });

    it("does not flag a plain URL even when long", () => {
      // Colons/slashes disqualify from the long-opaque fallback.
      expect(
        looksLikeSecret("https://example.com/very/long/path/to/resource?query=value&other=thing")
      ).toBe(false);
    });
  });
});
