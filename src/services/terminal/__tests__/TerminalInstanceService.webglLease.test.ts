import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/domain";
import type { ManagedTerminal } from "../types";
import type { RendererPolicyDeps } from "../TerminalRendererPolicy";

vi.mock("@/clients", () => ({
  terminalClient: {
    setActivityTier: vi.fn(),
  },
}));

describe("WebGL lease through tier transitions", () => {
  let policy: import("../TerminalRendererPolicy").TerminalRendererPolicy;
  let onTierApplied: ReturnType<typeof vi.fn>;
  let mockManagedTerminal: Partial<ManagedTerminal>;
  let mockDeps: RendererPolicyDeps;

  beforeEach(async () => {
    vi.clearAllMocks();

    (globalThis as unknown as { window: Window & typeof globalThis }).window = {
      ...(globalThis as unknown as { window?: Window & typeof globalThis }).window,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    } as Window & typeof globalThis;

    onTierApplied = vi.fn();

    mockManagedTerminal = {
      lastActiveTime: 0,
      lastAppliedTier: undefined,
      getRefreshTier: () => TerminalRefreshTier.FOCUSED,
      tierChangeTimer: undefined,
      pendingTier: undefined,
      needsWake: undefined,
      terminal: {
        refresh: vi.fn(),
        rows: 24,
      } as unknown as ManagedTerminal["terminal"],
    };

    mockDeps = {
      getInstance: vi.fn(() => mockManagedTerminal as ManagedTerminal),
      wakeAndRestore: vi.fn(() => Promise.resolve(true)),
      onTierApplied: onTierApplied as RendererPolicyDeps["onTierApplied"],
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    policy = new TerminalRendererPolicy(mockDeps);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("FOCUSED → BURST fires onTierApplied with BURST (not a detach trigger)", () => {
    mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;
    policy.applyRendererPolicy("t1", TerminalRefreshTier.BURST);

    expect(onTierApplied).toHaveBeenCalledWith(
      "t1",
      TerminalRefreshTier.BURST,
      mockManagedTerminal
    );
  });

  it("BURST → FOCUSED on same terminal fires onTierApplied with FOCUSED", () => {
    mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BURST;
    policy.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);

    // FOCUSED (100) > BURST (16) → downgrade → scheduled with hysteresis
    // We need to verify a pending tier was scheduled, not fired immediately
    expect(onTierApplied).not.toHaveBeenCalled();
    expect(mockManagedTerminal.pendingTier).toBe(TerminalRefreshTier.FOCUSED);
  });

  it("FOCUSED → BURST → FOCUSED does not cause redundant onTierApplied calls", () => {
    vi.useFakeTimers();
    (globalThis as unknown as { window: Window & typeof globalThis }).window = {
      ...(globalThis as unknown as { window?: Window & typeof globalThis }).window,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    } as Window & typeof globalThis;
    mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;

    // Keystroke: FOCUSED → BURST (upgrade, immediate)
    policy.applyRendererPolicy("t1", TerminalRefreshTier.BURST);
    expect(onTierApplied).toHaveBeenCalledTimes(1);
    expect(onTierApplied).toHaveBeenCalledWith(
      "t1",
      TerminalRefreshTier.BURST,
      mockManagedTerminal
    );

    // Burst timer expires: BURST → FOCUSED (downgrade, hysteresis)
    policy.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);
    // Not yet fired — waiting for hysteresis
    expect(onTierApplied).toHaveBeenCalledTimes(1);

    // After hysteresis
    vi.advanceTimersByTime(500);
    expect(onTierApplied).toHaveBeenCalledTimes(2);
    expect(onTierApplied).toHaveBeenLastCalledWith(
      "t1",
      TerminalRefreshTier.FOCUSED,
      mockManagedTerminal
    );

    vi.useRealTimers();
  });

  it("repeated BURST on same terminal is a no-op after initial apply", () => {
    mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;

    // First keystroke
    policy.applyRendererPolicy("t1", TerminalRefreshTier.BURST);
    expect(onTierApplied).toHaveBeenCalledTimes(1);

    // Subsequent keystrokes within burst window — same tier, should be no-op
    policy.applyRendererPolicy("t1", TerminalRefreshTier.BURST);
    expect(onTierApplied).toHaveBeenCalledTimes(1);
  });

  it("FOCUSED → VISIBLE is a downgrade and uses hysteresis", () => {
    vi.useFakeTimers();
    (globalThis as unknown as { window: Window & typeof globalThis }).window = {
      ...(globalThis as unknown as { window?: Window & typeof globalThis }).window,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    } as Window & typeof globalThis;
    mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;

    policy.applyRendererPolicy("t1", TerminalRefreshTier.VISIBLE);
    // Downgrade — should not fire immediately
    expect(onTierApplied).not.toHaveBeenCalled();
    expect(mockManagedTerminal.pendingTier).toBe(TerminalRefreshTier.VISIBLE);

    vi.advanceTimersByTime(500);
    expect(onTierApplied).toHaveBeenCalledWith(
      "t1",
      TerminalRefreshTier.VISIBLE,
      mockManagedTerminal
    );

    vi.useRealTimers();
  });

  it("FOCUSED → BACKGROUND fires onTierApplied after hysteresis", () => {
    vi.useFakeTimers();
    (globalThis as unknown as { window: Window & typeof globalThis }).window = {
      ...(globalThis as unknown as { window?: Window & typeof globalThis }).window,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    } as Window & typeof globalThis;
    mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.FOCUSED;

    policy.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
    expect(onTierApplied).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(onTierApplied).toHaveBeenCalledWith(
      "t1",
      TerminalRefreshTier.BACKGROUND,
      mockManagedTerminal
    );

    vi.useRealTimers();
  });
});
