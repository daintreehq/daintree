/**
 * Lease semantics for the MCP spawn focus guard. The critical regression: an
 * MCP-dispatched action whose handler never settles (confirm dialog torn down,
 * hung IPC — Main abandons the dispatch after 30s without cancelling the
 * renderer side) must not force `focusPolicy: "preserve"` on every later panel
 * creation in the project view forever. Symptom when it did: the dock's +
 * launch never auto-opened its popover again in that one project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { logWarn } from "@/utils/logger";
import { isMcpSpawnFocusSuppressed, runWithMcpSpawnFocusSuppressed } from "../mcpSpawnFocusGuard";

const LEASE_TTL_MS = 45_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mcpSpawnFocusGuard leases", () => {
  const pendingSettles: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Settle every hung dispatch a test created so module-level lease state
    // can't leak into the next test.
    for (const settle of pendingSettles.splice(0)) settle();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("suppresses while a dispatch is pending and releases on resolve", async () => {
    const { promise, resolve } = deferred<void>();
    const run = runWithMcpSpawnFocusSuppressed(() => promise);
    expect(isMcpSpawnFocusSuppressed()).toBe(true);
    resolve();
    await run;
    expect(isMcpSpawnFocusSuppressed()).toBe(false);
  });

  it("releases on rejection", async () => {
    const { promise, reject } = deferred<void>();
    const run = runWithMcpSpawnFocusSuppressed(() => promise);
    expect(isMcpSpawnFocusSuppressed()).toBe(true);
    reject(new Error("boom"));
    await expect(run).rejects.toThrow("boom");
    expect(isMcpSpawnFocusSuppressed()).toBe(false);
  });

  it("stops suppressing once a hung dispatch outlives the TTL and warns once", async () => {
    const { promise, resolve } = deferred<void>();
    const run = runWithMcpSpawnFocusSuppressed(() => promise, "agent.launch");
    pendingSettles.push(() => {
      resolve();
      void run;
    });

    vi.advanceTimersByTime(LEASE_TTL_MS - 1);
    expect(isMcpSpawnFocusSuppressed()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(isMcpSpawnFocusSuppressed()).toBe(false);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("lease outlived"),
      expect.objectContaining({ label: "agent.launch" })
    );

    // Repeated checks don't re-warn for the same lease.
    expect(isMcpSpawnFocusSuppressed()).toBe(false);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("a fresh dispatch still suppresses while an expired lease lingers", async () => {
    const hung = deferred<void>();
    const hungRun = runWithMcpSpawnFocusSuppressed(() => hung.promise, "worktree.create");
    pendingSettles.push(() => {
      hung.resolve();
      void hungRun;
    });
    vi.advanceTimersByTime(LEASE_TTL_MS);
    expect(isMcpSpawnFocusSuppressed()).toBe(false);

    const fresh = deferred<void>();
    const freshRun = runWithMcpSpawnFocusSuppressed(() => fresh.promise);
    expect(isMcpSpawnFocusSuppressed()).toBe(true);
    fresh.resolve();
    await freshRun;
    expect(isMcpSpawnFocusSuppressed()).toBe(false);
  });

  it("a late settle of an expired lease releases only itself", async () => {
    const hung = deferred<void>();
    const hungRun = runWithMcpSpawnFocusSuppressed(() => hung.promise);
    vi.advanceTimersByTime(LEASE_TTL_MS);

    const live = deferred<void>();
    const liveRun = runWithMcpSpawnFocusSuppressed(() => live.promise);
    pendingSettles.push(() => {
      live.resolve();
      void liveRun;
    });

    hung.resolve();
    await hungRun;
    // The live dispatch keeps suppressing — the stale release can't underflow
    // a shared counter the way the old depth implementation could.
    expect(isMcpSpawnFocusSuppressed()).toBe(true);
  });
});
