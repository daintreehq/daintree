import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_TIMEOUT_MINUTES,
  formatDuration,
  parseArgs,
  tailLinesFromFile,
} from "./run-e2e-watchdog.mjs";

describe("run-e2e-watchdog", () => {
  describe("parseArgs", () => {
    it("parses timeout and command arguments", () => {
      expect(
        parseArgs([
          "--timeout-minutes",
          "12.5",
          "--heartbeat-seconds",
          "30",
          "--",
          "npx",
          "playwright",
          "test",
          "--project=full-panels",
        ])
      ).toEqual({
        args: ["playwright", "test", "--project=full-panels"],
        command: "npx",
        heartbeatMs: 30_000,
        timeoutMs: 750_000,
      });
    });

    it("uses conservative defaults", () => {
      expect(parseArgs(["--", "npm", "run", "test:e2e"])).toEqual({
        args: ["run", "test:e2e"],
        command: "npm",
        heartbeatMs: DEFAULT_HEARTBEAT_SECONDS * 1000,
        timeoutMs: DEFAULT_TIMEOUT_MINUTES * 60 * 1000,
      });
    });

    it("rejects malformed arguments", () => {
      expect(() => parseArgs(["--timeout-minutes", "0", "--", "npm"])).toThrow(
        "must be a positive number"
      );
      expect(() => parseArgs(["--timeout-minutes", "5"])).toThrow("missing -- command separator");
      expect(() => parseArgs(["--unknown", "--", "npm"])).toThrow("unknown option");
    });
  });

  it("formats elapsed durations for heartbeat output", () => {
    expect(formatDuration(0)).toBe("0m 00s");
    expect(formatDuration(65_400)).toBe("1m 05s");
  });

  it("tails launch telemetry without failing when the file is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daintree-watchdog-"));
    const filePath = path.join(dir, "telemetry.jsonl");
    try {
      expect(tailLinesFromFile(path.join(dir, "missing.jsonl"))).toEqual([]);
      writeFileSync(filePath, "one\ntwo\nthree\nfour\n");
      expect(tailLinesFromFile(filePath, 2)).toEqual(["three", "four"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
