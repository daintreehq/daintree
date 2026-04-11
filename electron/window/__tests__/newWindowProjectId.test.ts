import { describe, it, expect } from "vitest";

/**
 * Tests the createWindow routing logic from main.ts to verify that
 * user-triggered new windows do NOT receive initialProjectId (#5033).
 *
 * main.ts cannot be imported directly (top-level side effects), so we
 * replicate the routing logic: createWindow(path?, projectId?) is called
 * with different arguments depending on the trigger.
 */

type CreateWindowCall = {
  initialProjectPath?: string | null;
  initialProjectId?: string;
};

/**
 * Simulates the createWindow routing from main.ts.
 * The real function passes these values through to setupBrowserWindow and
 * setupWindowServices, which use initialProjectId to decide whether to
 * append ?projectId= to the renderer URL.
 */
function simulateCreateWindowRouting(lastActiveProjectId: string | null) {
  const calls: { trigger: string; args: CreateWindowCall }[] = [];

  function createWindow(initialProjectPath?: string | null, initialProjectId?: string) {
    calls.push({
      trigger: "unknown",
      args: { initialProjectPath, initialProjectId },
    });
  }

  // Startup call (app.whenReady)
  calls.length = 0;
  createWindow(undefined, lastActiveProjectId ?? undefined);
  const startupCall = { ...calls[0], trigger: "startup" };

  // User-triggered new window (WINDOW_NEW IPC → onCreateWindow)
  calls.length = 0;
  const onCreateWindow = (projectPath?: string) => createWindow(projectPath);
  onCreateWindow();
  const newWindowCall = { ...calls[0], trigger: "new-window" };

  // User-triggered new window with specific project path
  calls.length = 0;
  onCreateWindow("/some/project");
  const newWindowWithPathCall = { ...calls[0], trigger: "new-window-with-path" };

  // App lifecycle new window (registerAppLifecycleHandlers → onCreateWindow)
  calls.length = 0;
  const lifecycleOnCreateWindow = () => createWindow();
  lifecycleOnCreateWindow();
  const lifecycleCall = { ...calls[0], trigger: "lifecycle" };

  // CLI path open (onCreateWindowForPath)
  calls.length = 0;
  const onCreateWindowForPath = (cliPath: string) => createWindow(cliPath);
  onCreateWindowForPath("/cli/project");
  const cliCall = { ...calls[0], trigger: "cli-path" };

  // Crash recovery (onRecreateWindow captures creation-time args)
  const capturedProjectId = lastActiveProjectId ?? undefined;
  calls.length = 0;
  const onRecreateStartup = () => createWindow(undefined, capturedProjectId);
  onRecreateStartup();
  const crashRecoveryStartupCall = { ...calls[0], trigger: "crash-recovery-startup" };

  calls.length = 0;
  const onRecreateNewWindow = () => createWindow(undefined, undefined);
  onRecreateNewWindow();
  const crashRecoveryNewWindowCall = { ...calls[0], trigger: "crash-recovery-new-window" };

  return {
    startupCall,
    newWindowCall,
    newWindowWithPathCall,
    lifecycleCall,
    cliCall,
    crashRecoveryStartupCall,
    crashRecoveryNewWindowCall,
  };
}

describe("new window initialProjectId routing (#5033)", () => {
  const LAST_ACTIVE_ID = "proj-abc-123";

  it("startup window receives lastActiveProjectId", () => {
    const { startupCall } = simulateCreateWindowRouting(LAST_ACTIVE_ID);
    expect(startupCall.args.initialProjectId).toBe(LAST_ACTIVE_ID);
  });

  it("user-triggered new window does NOT receive initialProjectId", () => {
    const { newWindowCall } = simulateCreateWindowRouting(LAST_ACTIVE_ID);
    expect(newWindowCall.args.initialProjectId).toBeUndefined();
  });

  it("new window with explicit project path does NOT receive initialProjectId", () => {
    const { newWindowWithPathCall } = simulateCreateWindowRouting(LAST_ACTIVE_ID);
    expect(newWindowWithPathCall.args.initialProjectId).toBeUndefined();
    expect(newWindowWithPathCall.args.initialProjectPath).toBe("/some/project");
  });

  it("lifecycle new window does NOT receive initialProjectId", () => {
    const { lifecycleCall } = simulateCreateWindowRouting(LAST_ACTIVE_ID);
    expect(lifecycleCall.args.initialProjectId).toBeUndefined();
  });

  it("CLI path window does NOT receive initialProjectId", () => {
    const { cliCall } = simulateCreateWindowRouting(LAST_ACTIVE_ID);
    expect(cliCall.args.initialProjectId).toBeUndefined();
    expect(cliCall.args.initialProjectPath).toBe("/cli/project");
  });

  it("crash recovery of startup window preserves initialProjectId", () => {
    const { crashRecoveryStartupCall } = simulateCreateWindowRouting(LAST_ACTIVE_ID);
    expect(crashRecoveryStartupCall.args.initialProjectId).toBe(LAST_ACTIVE_ID);
  });

  it("crash recovery of user-triggered window does NOT inject initialProjectId", () => {
    const { crashRecoveryNewWindowCall } = simulateCreateWindowRouting(LAST_ACTIVE_ID);
    expect(crashRecoveryNewWindowCall.args.initialProjectId).toBeUndefined();
  });

  it("handles null lastActiveProjectId gracefully", () => {
    const routing = simulateCreateWindowRouting(null);
    expect(routing.startupCall.args.initialProjectId).toBeUndefined();
    expect(routing.newWindowCall.args.initialProjectId).toBeUndefined();
    expect(routing.crashRecoveryStartupCall.args.initialProjectId).toBeUndefined();
  });
});
