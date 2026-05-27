import { describe, expect, it } from "vitest";
import { scrubSecrets, scrubLogLine } from "../pluginDiagnosticsScrub.js";
import type { PluginLogLine } from "../../types/plugin.js";

describe("scrubSecrets", () => {
  it("redacts GitHub tokens of every prefix", () => {
    const text =
      "ghp_abcdefghijklmnopqrstuvwxyz0123 gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 ghs_0123456789abcdefghijABCDE";
    const out = scrubSecrets(text);
    expect(out).not.toMatch(/gh[pous]_[A-Za-z0-9]/);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it("redacts OpenAI keys including project/service-account prefixes", () => {
    const out = scrubSecrets(
      "key=sk-abcdefghijklmnopqrstuvwxyz0123 proj=sk-proj-abcdefghijklmnopqrstuvwxyz"
    );
    expect(out).not.toContain("sk-abcdefghij");
    expect(out).not.toContain("sk-proj-abcdef");
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts AWS access key ids", () => {
    const out = scrubSecrets("aws AKIAIOSFODNN7EXAMPLE and ASIAY34FZKBOKMUTVV7A here");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("ASIAY34FZKBOKMUTVV7A");
  });

  it("redacts the credential in an Authorization Bearer header but keeps the scheme", () => {
    const out = scrubSecrets("Authorization: Bearer abc.def.ghi-jkl_mno");
    expect(out).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = scrubSecrets(`token ${jwt} end`);
    expect(out).toBe("token [REDACTED] end");
  });

  it("redacts JSON-ish secret values while preserving the key", () => {
    const out = scrubSecrets('{"api_key":"supersecretvalue","password":"hunter2pass"}');
    expect(out).toContain('"api_key":"[REDACTED]"');
    expect(out).toContain('"password":"[REDACTED]"');
  });

  it("leaves git SHAs, UUIDs, and ordinary text untouched", () => {
    const text =
      "commit f7aed9fba432cc82a9 uuid 550e8400-e29b-41d4-a716-446655440000 ran the build";
    expect(scrubSecrets(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = scrubSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(scrubSecrets(once)).toBe(once);
  });

  it("handles empty input", () => {
    expect(scrubSecrets("")).toBe("");
  });
});

describe("scrubLogLine", () => {
  it("scrubs message and fields without mutating the input", () => {
    const line: PluginLogLine = {
      timestamp: 123,
      level: "error",
      message: "auth failed with ghp_abcdefghijklmnopqrstuvwxyz0123",
      fields: '{"token":"sk-abcdefghijklmnopqrstuvwxyz0123"}',
    };
    const scrubbed = scrubLogLine(line);
    expect(scrubbed.message).toContain("[REDACTED]");
    expect(scrubbed.fields).toContain("[REDACTED]");
    expect(scrubbed.timestamp).toBe(123);
    expect(scrubbed.level).toBe("error");
    // Input untouched.
    expect(line.message).toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(line.fields).toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
  });

  it("omits fields when the line has none", () => {
    const line: PluginLogLine = { timestamp: 1, level: "info", message: "hello" };
    expect(scrubLogLine(line)).toEqual({ timestamp: 1, level: "info", message: "hello" });
  });
});
