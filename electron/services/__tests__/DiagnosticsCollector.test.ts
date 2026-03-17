import { describe, expect, it } from "vitest";

// We test the module-level helpers by importing them indirectly.
// Since redactDeep and withTimeout are not exported, we test them
// through collectDiagnostics or by extracting testable behavior.

// For now, test the redaction regex and timeout logic via isolated reproductions.

describe("DiagnosticsCollector helpers", () => {
  const SENSITIVE_KEY_PATTERN =
    /token|password|secret|apiKey|api_key|credential|authorization|private_key|passphrase/i;

  describe("SENSITIVE_KEY_PATTERN", () => {
    it("matches common sensitive key names", () => {
      const sensitiveKeys = [
        "token",
        "accessToken",
        "password",
        "secret",
        "apiKey",
        "api_key",
        "credential",
        "authorization",
        "private_key",
        "passphrase",
        "GITHUB_TOKEN",
        "DB_PASSWORD",
        "API_SECRET",
      ];

      for (const key of sensitiveKeys) {
        expect(SENSITIVE_KEY_PATTERN.test(key), `should match: ${key}`).toBe(true);
      }
    });

    it("does not match safe key names", () => {
      const safeKeys = [
        "username",
        "email",
        "hostname",
        "platform",
        "version",
        "path",
        "enabled",
        "scrollback",
      ];

      for (const key of safeKeys) {
        expect(SENSITIVE_KEY_PATTERN.test(key), `should not match: ${key}`).toBe(false);
      }
    });
  });

  describe("URL credential stripping", () => {
    const stripCredentials = (str: string) =>
      str.replace(/https?:\/\/[^@\s]+@/g, "https://<redacted>@");

    it("strips basic auth from HTTPS URLs", () => {
      expect(stripCredentials("https://user:pass@github.com/repo.git")).toBe(
        "https://<redacted>@github.com/repo.git"
      );
    });

    it("strips token-style auth from URLs", () => {
      expect(stripCredentials("https://x-access-token:ghp_abc123@github.com/repo.git")).toBe(
        "https://<redacted>@github.com/repo.git"
      );
    });

    it("leaves URLs without credentials unchanged", () => {
      expect(stripCredentials("https://github.com/repo.git")).toBe("https://github.com/repo.git");
    });
  });

  describe("withTimeout pattern", () => {
    function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
      return Promise.race([
        promise,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
      ]);
    }

    it("returns the resolved value when promise completes before timeout", async () => {
      const result = await withTimeout(Promise.resolve("ok"), 1000, "fallback");
      expect(result).toBe("ok");
    });

    it("returns fallback when promise exceeds timeout", async () => {
      const slow = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 5000));
      const result = await withTimeout(slow, 10, "fallback");
      expect(result).toBe("fallback");
    });

    it("returns fallback object for timed out sections", async () => {
      const slow = new Promise<Record<string, unknown>>(() => {});
      const result = await withTimeout(slow, 10, { error: "timed out" });
      expect(result).toEqual({ error: "timed out" });
    });
  });

  describe("redactDeep pattern", () => {
    function redactDeep(value: unknown): unknown {
      if (value === null || value === undefined) return value;
      if (typeof value === "string") {
        return value.replace(/https?:\/\/[^@\s]+@/g, "https://<redacted>@");
      }
      if (Array.isArray(value)) return value.map(redactDeep);
      if (typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
          if (SENSITIVE_KEY_PATTERN.test(key)) {
            result[key] = "<redacted>";
          } else {
            result[key] = redactDeep(val);
          }
        }
        return result;
      }
      return value;
    }

    it("redacts sensitive keys in nested objects", () => {
      const input = {
        name: "test",
        config: {
          apiKey: "sk-12345",
          endpoint: "https://api.example.com",
        },
      };
      const result = redactDeep(input) as Record<string, unknown>;
      expect((result.config as Record<string, unknown>).apiKey).toBe("<redacted>");
      expect((result.config as Record<string, unknown>).endpoint).toBe("https://api.example.com");
    });

    it("redacts sensitive keys in arrays of objects", () => {
      const input = [{ token: "abc123" }, { name: "safe" }];
      const result = redactDeep(input) as Array<Record<string, unknown>>;
      expect(result[0].token).toBe("<redacted>");
      expect(result[1].name).toBe("safe");
    });

    it("preserves null and undefined", () => {
      expect(redactDeep(null)).toBe(null);
      expect(redactDeep(undefined)).toBe(undefined);
    });

    it("preserves numbers and booleans", () => {
      expect(redactDeep(42)).toBe(42);
      expect(redactDeep(true)).toBe(true);
    });

    it("strips credentials from URLs in string values", () => {
      const result = redactDeep("https://user:pass@host.com/path");
      expect(result).toBe("https://<redacted>@host.com/path");
    });
  });
});
