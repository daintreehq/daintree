import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { takeProcessKillViolations } from "./helpers/processKillGuard.js";

// Runs only under vitest.integration.config.ts: proves the setup file the
// config names actually applied the isolation guards in a live worker (#15588).

describe("integration worker isolation", () => {
  it("points DAINTREE_USER_DATA at this worker's temp root", () => {
    const userData = process.env.DAINTREE_USER_DATA ?? "";
    expect(path.isAbsolute(userData)).toBe(true);
    expect(userData.startsWith(os.tmpdir())).toBe(true);
    expect(userData).toContain(String(process.pid));
  });

  it("does not inherit Canopy trace or pace settings", () => {
    expect(process.env.DAINTREE_CANOPY_TRACE).toBeUndefined();
    expect(process.env.DAINTREE_CANOPY_BACKGROUND_POLL_MS).toBeUndefined();
  });

  it("refuses to signal a process this worker did not spawn", () => {
    let code: string | undefined;
    try {
      // The parent is the vitest runner: alive, and not ours to signal.
      process.kill(process.ppid, "SIGCONT");
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBeDefined();
    // The violation would fail this test in afterEach; drain it, it is the point.
    expect(takeProcessKillViolations()).toHaveLength(1);
  });
});
