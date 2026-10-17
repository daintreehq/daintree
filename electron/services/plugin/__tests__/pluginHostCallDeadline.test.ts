import { describe, expect, it } from "vitest";
import {
  hostCallDeadlineMs,
  hostCallTimeoutError,
  isHostCallTimeoutError,
} from "../pluginHostCallDeadline.js";

describe("hostCallDeadlineMs (#13410)", () => {
  it("leaves the prompts unbounded, since they wait on a person", () => {
    for (const method of ["showQuickPick", "showInputBox", "showConfirm"] as const) {
      expect(hostCallDeadlineMs(method, {})).toBe(0);
    }
  });

  it("bounds an untargeted sendToAgent only once it names a terminal", () => {
    expect(hostCallDeadlineMs("sendToAgent", { text: "hi" })).toBe(0);
    expect(hostCallDeadlineMs("sendToAgent", undefined)).toBe(0);
    expect(
      hostCallDeadlineMs("sendToAgent", { text: "hi", options: { terminalId: "t1" } })
    ).toBeGreaterThan(0);
  });

  it("waits longer for a call that can raise a consent dialog than for a plain read", () => {
    const read = hostCallDeadlineMs("fs.readFile", { path: "a" });
    expect(read).toBeGreaterThan(0);
    for (const method of ["terminals.readScreen", "fs.writeFile", "process.spawn"] as const) {
      expect(hostCallDeadlineMs(method, {})).toBeGreaterThan(read);
    }
  });

  it("bounds the calls the reported hangs came from", () => {
    expect(hostCallDeadlineMs("terminals.readScreen", {})).toBeGreaterThan(0);
    expect(hostCallDeadlineMs("settings.get", {})).toBeGreaterThan(0);
  });
});

describe("hostCallTimeoutError", () => {
  it("carries the TIMEOUT code and names the method, never the params", () => {
    const err = hostCallTimeoutError("acme.demo", "settings.get", 1234);
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toMatch(/^TIMEOUT: /);
    expect(err.message).toContain("settings.get");
    expect(err.message).toContain("1234ms");
    expect(isHostCallTimeoutError(err)).toBe(true);
    expect(isHostCallTimeoutError(new Error("TIMEOUT: lookalike"))).toBe(false);
  });
});
