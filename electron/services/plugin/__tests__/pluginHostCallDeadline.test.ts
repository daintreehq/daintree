import { describe, expect, it } from "vitest";
import {
  hostCallDeadlineMs,
  hostCallTimeoutError,
  isHostCallTimeoutError,
} from "../pluginHostCallDeadline.js";
import {
  PLUGIN_SERVICE_DEFAULT_TIMEOUT_MS,
  PLUGIN_SERVICE_MAX_TIMEOUT_MS,
} from "../../../../shared/config/pluginBudgets.js";

describe("hostCallDeadlineMs (#13410)", () => {
  it("leaves the prompts unbounded, since they wait on a person", () => {
    for (const method of ["showQuickPick", "showInputBox", "showConfirm"] as const) {
      expect(hostCallDeadlineMs(method, {})).toBe(0);
    }
  });

  it("never bounds a recipe run, which waits on the user reading it (#13797)", () => {
    expect(hostCallDeadlineMs("runRecipe", { recipeId: "review" })).toBe(0);
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
    for (const method of [
      "terminals.readScreen",
      "fs.writeFile",
      "process.spawn",
      "agents.interrupt",
      "agents.sendKeys",
      "agents.submit",
    ] as const) {
      expect(hostCallDeadlineMs(method, {})).toBeGreaterThan(read);
    }
  });

  it("waits past a service call's own deadline, so main's typed timeout arrives first (#14105)", () => {
    const params = (timeoutMs?: unknown) => ({
      name: "acme.jira.issues",
      method: "lookup",
      timeoutMs,
    });
    const byDefault = hostCallDeadlineMs("services.call", params());
    expect(byDefault).toBeGreaterThan(PLUGIN_SERVICE_DEFAULT_TIMEOUT_MS);
    expect(hostCallDeadlineMs("services.call", params(500))).toBeGreaterThan(500);
    expect(hostCallDeadlineMs("services.call", params(500))).toBeLessThan(byDefault);
    // Main refuses an out-of-range value at once; the worker still waits a bounded time.
    expect(hostCallDeadlineMs("services.call", params(10 ** 9))).toBe(
      hostCallDeadlineMs("services.call", params(PLUGIN_SERVICE_MAX_TIMEOUT_MS))
    );
    expect(hostCallDeadlineMs("services.call", params("soon"))).toBe(byDefault);
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
