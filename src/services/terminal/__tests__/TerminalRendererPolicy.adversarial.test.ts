import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@shared/types/panel";
import type { ManagedTerminal } from "../types";
import type { RendererPolicyDeps } from "../TerminalRendererPolicy";

vi.mock("@/clients", () => ({
  terminalClient: {
    setActivityTier: vi.fn(),
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createManagedTerminal(
  overrides: Partial<ManagedTerminal> = {}
): ManagedTerminal & { terminal: { refresh: ReturnType<typeof vi.fn>; rows: number } } {
  return {
    lastActiveTime: 0,
    lastAppliedTier: TerminalRefreshTier.FOCUSED,
    getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    pendingTier: undefined,
    tierChangeTimer: undefined,
    needsWake: undefined,
    terminal: {
      refresh: vi.fn(),
      rows: 24,
    },
    ...overrides,
  } as ManagedTerminal & { terminal: { refresh: ReturnType<typeof vi.fn>; rows: number } };
}

describe("TerminalRendererPolicy adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("DISPOSE_CANCELS_PENDING_DOWNGRADE", async () => {
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
      wakeAndRestore: vi.fn(async () => true),
      onTierApplied: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);

    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.BACKGROUND);
    policy.dispose();
    vi.advanceTimersByTime(1000);

    const { terminalClient } = await import("@/clients");
    expect(terminalClient.setActivityTier).not.toHaveBeenCalled();
    expect(deps.onTierApplied).not.toHaveBeenCalled();
    expect(managed.pendingTier).toBeUndefined();
    expect(managed.tierChangeTimer).toBeUndefined();
    expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
  });

  it("CLEAR_TIER_STATE_PREVENTS_STALE_FLIP", async () => {
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
      wakeAndRestore: vi.fn(async () => true),
      onTierApplied: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);

    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.BACKGROUND);
    policy.clearTierState("terminal-1");
    vi.advanceTimersByTime(1000);

    const { terminalClient } = await import("@/clients");
    expect(terminalClient.setActivityTier).not.toHaveBeenCalled();
    expect(deps.onTierApplied).not.toHaveBeenCalled();
    expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.FOCUSED);
  });

  it("WAKE_AFTER_INSTANCE_SWAP_NO_WRONG_REFRESH", async () => {
    const wake = deferred<boolean>();
    const original = createManagedTerminal({
      lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      needsWake: true,
    });
    const replacement = createManagedTerminal({
      lastAppliedTier: TerminalRefreshTier.BACKGROUND,
    });
    let currentManaged: ManagedTerminal | undefined = original;

    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => currentManaged),
      wakeAndRestore: vi.fn(() => wake.promise),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);
    policy.initializeBackendTier("terminal-1", "background");

    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.FOCUSED);
    currentManaged = replacement;
    wake.resolve(true);
    await wake.promise;
    await Promise.resolve();

    expect(original.terminal.refresh).not.toHaveBeenCalled();
    expect(replacement.terminal.refresh).not.toHaveBeenCalled();
    expect(original.needsWake).toBe(true);
    expect(replacement.needsWake).toBeUndefined();
  });

  it("CHURN_COLLAPSES_TO_LAST_TIER", async () => {
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
      wakeAndRestore: vi.fn(async () => true),
      onTierApplied: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);

    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.BACKGROUND);
    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.VISIBLE);
    vi.advanceTimersByTime(1000);

    const { terminalClient } = await import("@/clients");
    expect(terminalClient.setActivityTier).not.toHaveBeenCalledWith("terminal-1", "background");
    expect(managed.lastAppliedTier).toBe(TerminalRefreshTier.VISIBLE);
    expect(deps.onTierApplied).toHaveBeenCalledTimes(1);
    expect(deps.onTierApplied).toHaveBeenCalledWith(
      "terminal-1",
      TerminalRefreshTier.VISIBLE,
      managed
    );
  });

  it("PER_TERMINAL_TIMERS_ISOLATED", async () => {
    const managedA = createManagedTerminal();
    const managedB = createManagedTerminal();
    const managedById = new Map<string, ManagedTerminal>([
      ["terminal-a", managedA],
      ["terminal-b", managedB],
    ]);
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn((id: string) => managedById.get(id)),
      wakeAndRestore: vi.fn(async () => true),
      onTierApplied: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);

    policy.applyRendererPolicy("terminal-a", TerminalRefreshTier.BACKGROUND);
    policy.applyRendererPolicy("terminal-b", TerminalRefreshTier.BACKGROUND);
    policy.applyRendererPolicy("terminal-a", TerminalRefreshTier.VISIBLE);
    vi.advanceTimersByTime(1000);

    expect(managedA.lastAppliedTier).toBe(TerminalRefreshTier.VISIBLE);
    expect(managedB.lastAppliedTier).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("WAKE_REJECTION_AFTER_REMOVAL_SILENT", async () => {
    const wake = deferred<boolean>();
    const managed = createManagedTerminal({
      lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      needsWake: true,
    });
    let currentManaged: ManagedTerminal | undefined = managed;
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => currentManaged),
      wakeAndRestore: vi.fn(() => wake.promise),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);
    policy.initializeBackendTier("terminal-1", "background");

    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.FOCUSED);
    currentManaged = undefined;
    wake.reject(new Error("wake failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });

  it("CLEAR_TIER_STATE_CANCELS_PENDING_WAKE_AND_RELEASES_GENERATION", async () => {
    const wake = deferred<boolean>();
    const managed = createManagedTerminal({
      lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      needsWake: true,
    });
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
      wakeAndRestore: vi.fn(() => wake.promise),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);
    policy.initializeBackendTier("terminal-1", "background");

    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.FOCUSED);
    policy.clearTierState("terminal-1");
    wake.resolve(true);
    await wake.promise;
    await Promise.resolve();

    expect(managed.terminal.refresh).not.toHaveBeenCalled();
    expect((policy as unknown as { wakeGeneration: Map<string, number> }).wakeGeneration.size).toBe(
      0
    );
  });
});
