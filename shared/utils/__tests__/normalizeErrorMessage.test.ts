import { describe, expect, it } from "vitest";
import { normalizeForDedup } from "../normalizeErrorMessage.js";

describe("normalizeForDedup", () => {
  it("strips UUIDs", () => {
    expect(normalizeForDedup("Error abc12345-6789-4abc-def0-123456789abc occurred")).toBe(
      "Error occurred"
    );
  });

  it("strips ISO 8601 timestamps", () => {
    expect(normalizeForDedup("Timeout at 2024-01-15T08:30:00Z for request")).toBe(
      "Timeout at for request"
    );
  });

  it("strips ISO timestamps with fractional seconds", () => {
    expect(normalizeForDedup("Timeout at 2024-01-15T08:30:00.123Z for request")).toBe(
      "Timeout at for request"
    );
  });

  it("strips ISO timestamps with numeric timezone", () => {
    expect(normalizeForDedup("Timeout at 2024-01-15T08:30:00+05:30 for request")).toBe(
      "Timeout at for request"
    );
  });

  it("strips git SHAs", () => {
    expect(
      normalizeForDedup(
        "fatal: ambiguous argument 'abc123def456789012345678901234567890abcd': unknown revision"
      )
    ).toBe("fatal: ambiguous argument '': unknown revision");
  });

  it("strips 13-digit epoch milliseconds", () => {
    expect(normalizeForDedup("Request 1705310400123 timed out")).toBe("Request timed out");
  });

  it("does not strip numbers that are not 13-digit epoch ms", () => {
    expect(normalizeForDedup("Port 3000 is in use")).toBe("Port 3000 is in use");
    expect(normalizeForDedup("Version 2.4.1 released")).toBe("Version 2.4.1 released");
  });

  it("strips PID suffixes", () => {
    expect(normalizeForDedup("Process pid 12345 exited unexpectedly")).toBe(
      "Process exited unexpectedly"
    );
  });

  it("strips process number suffixes", () => {
    expect(normalizeForDedup("Process process 67890 crashed")).toBe("Process crashed");
  });

  it("strips EADDRINUSE port after localhost", () => {
    const a = "connect ECONNREFUSED localhost:3000";
    const b = "connect ECONNREFUSED localhost:4000";
    expect(normalizeForDedup(a)).toBe(normalizeForDedup(b));
  });

  it("strips quoted absolute macOS paths", () => {
    expect(
      normalizeForDedup('ENOENT: no such file or directory, open "/Users/test/file.txt"')
    ).toBe('ENOENT: no such file or directory, open ""');
  });

  it("strips quoted absolute Windows paths", () => {
    expect(
      normalizeForDedup('ENOENT: no such file or directory, open "C:\\Users\\test\\file.txt"')
    ).toBe(
      /* collapsed whitespace */ normalizeForDedup(
        'ENOENT: no such file or directory, open "D:\\other\\file.txt"'
      )
    );
  });

  it("passes through messages with no volatile content", () => {
    expect(normalizeForDedup("Git push failed")).toBe("Git push failed");
  });

  it("collapses whitespace from removed fragments", () => {
    expect(normalizeForDedup("listen EADDRINUSE: address already in use :::3000")).toBe(
      "listen EADDRINUSE: address already in use"
    );
  });

  it("handles messages with multiple volatile patterns", () => {
    const input =
      'Error abc12345-5678-4abc-def0-123456789abc at 2024-01-15T08:30:00Z: pid 12345 failed on "/Users/test/file.txt"';
    const result = normalizeForDedup(input);
    expect(result).not.toContain("abc12345");
    expect(result).not.toContain("2024-01-15");
    expect(result).not.toContain("12345");
    expect(result).not.toContain("/Users/test/file.txt");
    expect(result).toContain("Error");
  });

  it("returns original message when normalization empties the string", () => {
    expect(normalizeForDedup("1705310400123")).toBe("1705310400123");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeForDedup("")).toBe("");
  });
});
