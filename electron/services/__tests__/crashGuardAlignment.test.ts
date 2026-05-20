import { describe, expect, it, vi } from "vitest";

// The three crash-loop guards intentionally duplicate their decay-window
// constant rather than sharing a module — they operate at independent layers
// (disk-persisted app-level vs. in-memory utility-process) and must remain
// decoupled. This alignment test is the failure mechanism the source comments
// promise: any future tuning of one constant fails this test until the other
// two are updated to match. If the desired policy genuinely diverges, this
// test should be deleted in the same PR that introduces the divergence.

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  utilityProcess: { fork: () => undefined },
  UtilityProcess: class {},
  MessagePortMain: class {},
}));

vi.mock("../../utils/fs.js", () => ({ resilientAtomicWriteFileSync: () => undefined }));

vi.mock("../github/GitHubAuth.js", () => ({ GitHubAuth: { getToken: () => null } }));

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

describe("crash-loop guard alignment", () => {
  it("the three guards share a single CRASH_WINDOW_MS value", async () => {
    const [guard, ptyLifecycle, workspaceHost] = await Promise.all([
      import("../CrashLoopGuardService.js"),
      import("../pty/PtyHostLifecycle.js"),
      import("../WorkspaceHostProcess.js"),
    ]);

    expect(guard.CRASH_WINDOW_MS).toBe(ptyLifecycle.CRASH_WINDOW_MS);
    expect(ptyLifecycle.CRASH_WINDOW_MS).toBe(workspaceHost.CRASH_WINDOW_MS);
    // Sanity check the policy itself — three rapid crashes (~few seconds
    // apart) still trip the cap, and a 6-minute-cadence slow flap (the #8683
    // blind spot) does too. Bumping below 18 minutes would let chronic
    // 6-min-cadence crashers slip through again; bumping above 1 hour would
    // make the boot-time decay surprising. Update intentionally.
    expect(guard.CRASH_WINDOW_MS).toBeGreaterThanOrEqual(18 * 60_000);
    expect(guard.CRASH_WINDOW_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});
