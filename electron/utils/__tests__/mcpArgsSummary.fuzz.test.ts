import { describe, expect } from "vitest";
import { fc, test } from "@fast-check/vitest";
import { summarizeMcpArgs } from "../../../shared/utils/mcpArgsSummary.js";
import { scrubSecrets } from "../secretScrubber.js";
import { sanitizePath } from "../pathScrubber.js";

function productionSummarize(args: unknown): string {
  return summarizeMcpArgs(args, (s) => scrubSecrets(sanitizePath(s)));
}

const SENSITIVE_KEYS = [
  "token",
  "password",
  "apiKey",
  "secret",
  "authToken",
  "credential",
  "bearerToken",
  "api_key",
  "access_token",
  "authorization",
] as const;

const NON_SENSITIVE_KEYS = [
  "message",
  "note",
  "body",
  "description",
  "data",
  "content",
  "text",
  "value",
] as const;

const HOMOGLYPH_KEYS = [
  "pаssword", // Cyrillic а (U+0430)
  "αpi_key", // Greek α (U+03B1)
  "tоken", // Cyrillic о (U+03BF)
  "sеcret", // Cyrillic е (U+0435)
  "passwοrd", // Greek ο (U+03BF)
  "auth_kеy", // Cyrillic е (U+0435)
] as const;

const KEY_TYPOS = [
  "tokne", // transposed n-e, no sensitive substring match
  "passw0rd", // 0 for o, no sensitive substring match
  "api_kye", // transposed y-e, no sensitive substring match
  "credental", // missing i, no sensitive substring match
  "secrets_v2", // contains "secret" → matches SENSITIVE_KEY_PATTERN
  "tokenized", // contains "token" → matches
  "authz", // contains "auth" → matches
  "apikey_legacy", // contains "apikey" → matches via api[_-]?key
] as const;

describe("mcpArgsSummary property tests", () => {
  test.prop([fc.nat().map((n) => `CANARY-DAINTREE-${n}`), fc.constantFrom(...SENSITIVE_KEYS)])(
    "canary under a sensitive key is never present in the output (key-name redaction layer)",
    (canary, sensitiveKey) => {
      const args = { [sensitiveKey]: canary };
      const output = productionSummarize(args);
      expect(output).not.toContain(canary);
    }
  );

  test.prop([fc.nat().map((n) => `CANARY-DAINTREE-${n}`), fc.constantFrom(...NON_SENSITIVE_KEYS)])(
    "canary inside a Bearer token under a non-sensitive key is scrubbed (post-serialize scrubber integration)",
    (canary, key) => {
      const args = { [key]: `Bearer ${canary}` };
      const output = productionSummarize(args);
      expect(output).not.toContain(canary);
    }
  );

  test.prop([
    fc.letrec((tie) => ({
      jsonValue: fc.oneof(
        { depthSize: "small", maxDepth: 10 },
        tie("leaf"),
        tie("object"),
        tie("array")
      ),
      leaf: fc.oneof(
        fc.string({ maxLength: 200 }),
        fc.integer({ min: -1000000, max: 1000000 }),
        fc.boolean(),
        fc.constant(null),
        fc.nat().map((n) => `CANARY-DAINTREE-${n}`)
      ),
      object: fc.dictionary(
        fc.oneof(
          fc.constantFrom(
            ...SENSITIVE_KEYS,
            ...HOMOGLYPH_KEYS,
            ...KEY_TYPOS,
            "name",
            "file",
            "path",
            "query",
            "id",
            "type",
            "label",
            "toolId",
            "url"
          ),
          fc.string({ maxLength: 20 })
        ),
        tie("jsonValue"),
        { minKeys: 0, maxKeys: 6 }
      ),
      array: fc.array(tie("jsonValue"), { maxLength: 5 }),
    })).jsonValue,
  ])("adversarial shapes produce valid non-empty string output without crashing", (value) => {
    const output = productionSummarize(value);
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });
});
