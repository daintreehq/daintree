import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { appendEmergencyLog, emergencyLogFatal, getEmergencyLogPath } from "../emergencyLog.js";

describe("pty-host emergencyLog", () => {
  let tmpDir: string;
  let prevUserData: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-host-emergency-log-"));
    prevUserData = process.env.DAINTREE_USER_DATA;
    process.env.DAINTREE_USER_DATA = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevUserData === undefined) {
      delete process.env.DAINTREE_USER_DATA;
    } else {
      process.env.DAINTREE_USER_DATA = prevUserData;
    }
  });

  describe("getEmergencyLogPath", () => {
    it("returns path under DAINTREE_USER_DATA/logs", () => {
      expect(getEmergencyLogPath()).toBe(path.join(tmpDir, "logs", "pty-host.log"));
    });
  });

  describe("appendEmergencyLog", () => {
    it("creates the log file on first append", () => {
      appendEmergencyLog("first line\n");
      const content = fs.readFileSync(getEmergencyLogPath(), "utf8");
      expect(content).toBe("first line\n");
    });

    it("appends to an existing log file", () => {
      appendEmergencyLog("a\n");
      appendEmergencyLog("b\n");
      const content = fs.readFileSync(getEmergencyLogPath(), "utf8");
      expect(content).toBe("a\nb\n");
    });

    it("does not throw when fs operations fail", () => {
      process.env.DAINTREE_USER_DATA = "/nonexistent/readonly/path";
      expect(() => appendEmergencyLog("test\n")).not.toThrow();
    });
  });

  describe("emergencyLogFatal", () => {
    it("logs Error objects with name, message, and stack", () => {
      const err = new Error("test error");
      err.name = "TestError";
      emergencyLogFatal("UNCAUGHT_EXCEPTION", err);

      const content = fs.readFileSync(getEmergencyLogPath(), "utf8");
      expect(content).toContain("[UNCAUGHT_EXCEPTION]");
      expect(content).toContain('"name":"TestError"');
      expect(content).toContain('"message":"test error"');
    });

    it("scrubs known secret sigils from error.message and stack", () => {
      const githubPat = `ghp_${"A".repeat(40)}`;
      const anthropicKey = `sk-ant-${"a".repeat(95)}`;
      const err = new Error(`auth failed with ${githubPat}`);
      err.stack = `Error: bad key ${anthropicKey}\n    at fake (/tmp/x.js:1:1)`;

      emergencyLogFatal("UNHANDLED_REJECTION", err);

      const content = fs.readFileSync(getEmergencyLogPath(), "utf8");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain(githubPat);
      expect(content).not.toContain(anthropicKey);
    });
  });
});
