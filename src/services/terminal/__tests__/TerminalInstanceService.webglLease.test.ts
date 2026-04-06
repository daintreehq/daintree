import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import type { ManagedTerminal } from "../types";
import { TIER_DOWNGRADE_HYSTERESIS_MS } from "../types";
import type { RendererPolicyDeps } from "../TerminalRendererPolicy";

vi.mock("@/clients", () => ({
  terminalClient: {
    setActivityTier: vi.fn(),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () {
    return {
      dispose: vi.fn(),
      onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
    };
  }),
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
    vi.advanceTimersByTime(TIER_DOWNGRADE_HYSTERESIS_MS);
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

    vi.advanceTimersByTime(TIER_DOWNGRADE_HYSTERESIS_MS);
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

    vi.advanceTimersByTime(TIER_DOWNGRADE_HYSTERESIS_MS);
    expect(onTierApplied).toHaveBeenCalledWith(
      "t1",
      TerminalRefreshTier.BACKGROUND,
      mockManagedTerminal
    );

    vi.useRealTimers();
  });

  it("pending FOCUSED downgrade is cancelled by renewed BURST", () => {
    vi.useFakeTimers();
    (globalThis as unknown as { window: Window & typeof globalThis }).window = {
      ...(globalThis as unknown as { window?: Window & typeof globalThis }).window,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    } as Window & typeof globalThis;
    mockManagedTerminal.lastAppliedTier = TerminalRefreshTier.BURST;

    // Burst timer wants to downgrade to FOCUSED
    policy.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);
    expect(mockManagedTerminal.pendingTier).toBe(TerminalRefreshTier.FOCUSED);

    // Another keystroke arrives before hysteresis expires → BURST upgrade cancels pending
    policy.applyRendererPolicy("t1", TerminalRefreshTier.BURST);
    expect(mockManagedTerminal.pendingTier).toBeUndefined();
    expect(mockManagedTerminal.tierChangeTimer).toBeUndefined();

    // After hysteresis, no callback should have fired — the pending FOCUSED was cancelled
    vi.advanceTimersByTime(TIER_DOWNGRADE_HYSTERESIS_MS);
    expect(onTierApplied).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe("onTierApplied handler — WebGL manager integration", () => {
  let webGLManager: import("../TerminalWebGLManager").TerminalWebGLManager;
  let managed: ManagedTerminal;

  function makeManagedTerminal(kind: "agent" | "terminal" = "agent"): ManagedTerminal {
    return {
      terminal: { loadAddon: vi.fn(), refresh: vi.fn(), rows: 24 },
      isOpened: true,
      lastActiveTime: Date.now(),
      kind,
    } as unknown as ManagedTerminal;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
    webGLManager = new TerminalWebGLManager();
    managed = makeManagedTerminal();
  });

  function simulateOnTierApplied(id: string, tier: TerminalRefreshTier, m: ManagedTerminal) {
    if ((m as unknown as { kind?: string }).kind !== "agent") return;

    if (
      tier === TerminalRefreshTier.FOCUSED ||
      tier === TerminalRefreshTier.BURST ||
      tier === TerminalRefreshTier.VISIBLE
    ) {
      webGLManager.ensureContext(id, m);
    } else {
      const hadWebGL = webGLManager.isActive(id);
      webGLManager.releaseContext(id);
      if (hadWebGL && m.terminal.rows > 0) {
        m.terminal.refresh(0, m.terminal.rows - 1);
      }
    }
  }

  it("BURST does not detach WebGL from focused terminal", () => {
    simulateOnTierApplied("t1", TerminalRefreshTier.FOCUSED, managed);
    expect(webGLManager.isActive("t1")).toBe(true);

    simulateOnTierApplied("t1", TerminalRefreshTier.BURST, managed);
    expect(webGLManager.isActive("t1")).toBe(true);
  });

  it("FOCUSED → VISIBLE retains context", () => {
    simulateOnTierApplied("t1", TerminalRefreshTier.FOCUSED, managed);
    expect(webGLManager.isActive("t1")).toBe(true);

    simulateOnTierApplied("t1", TerminalRefreshTier.VISIBLE, managed);
    expect(webGLManager.isActive("t1")).toBe(true);
  });

  it("VISIBLE terminal acquires its own context", () => {
    const managed2 = makeManagedTerminal();
    simulateOnTierApplied("t1", TerminalRefreshTier.FOCUSED, managed);
    expect(webGLManager.isActive("t1")).toBe(true);

    simulateOnTierApplied("t2", TerminalRefreshTier.VISIBLE, managed2);
    expect(webGLManager.isActive("t1")).toBe(true);
    expect(webGLManager.isActive("t2")).toBe(true);
  });

  it("BACKGROUND releases context for that terminal only", () => {
    const managed2 = makeManagedTerminal();
    simulateOnTierApplied("t1", TerminalRefreshTier.FOCUSED, managed);
    simulateOnTierApplied("t2", TerminalRefreshTier.VISIBLE, managed2);

    simulateOnTierApplied("t1", TerminalRefreshTier.BACKGROUND, managed);
    expect(webGLManager.isActive("t1")).toBe(false);
    expect(webGLManager.isActive("t2")).toBe(true);
  });

  it("focus switch A→B keeps both active when both visible", () => {
    const managedB = makeManagedTerminal();
    simulateOnTierApplied("t1", TerminalRefreshTier.FOCUSED, managed);
    expect(webGLManager.isActive("t1")).toBe(true);

    simulateOnTierApplied("t2", TerminalRefreshTier.FOCUSED, managedB);
    expect(webGLManager.isActive("t1")).toBe(true);
    expect(webGLManager.isActive("t2")).toBe(true);
  });

  it("A retains context at VISIBLE while B takes focus", () => {
    const managedB = makeManagedTerminal();
    simulateOnTierApplied("t1", TerminalRefreshTier.FOCUSED, managed);

    simulateOnTierApplied("t1", TerminalRefreshTier.VISIBLE, managed);
    expect(webGLManager.isActive("t1")).toBe(true);

    simulateOnTierApplied("t2", TerminalRefreshTier.FOCUSED, managedB);
    expect(webGLManager.isActive("t2")).toBe(true);
    expect(webGLManager.isActive("t1")).toBe(true);
  });

  it("standard terminal at FOCUSED never acquires WebGL context", () => {
    const stdManaged = makeManagedTerminal("terminal");
    simulateOnTierApplied("t-std", TerminalRefreshTier.FOCUSED, stdManaged);
    expect(webGLManager.isActive("t-std")).toBe(false);
  });

  it("standard terminal at BURST/VISIBLE never acquires WebGL context", () => {
    const stdManaged = makeManagedTerminal("terminal");
    simulateOnTierApplied("t-std", TerminalRefreshTier.BURST, stdManaged);
    expect(webGLManager.isActive("t-std")).toBe(false);
    simulateOnTierApplied("t-std", TerminalRefreshTier.VISIBLE, stdManaged);
    expect(webGLManager.isActive("t-std")).toBe(false);
  });

  it("rapid tier churn on standard terminal does not create pool entries", () => {
    const stdManaged = makeManagedTerminal("terminal");
    const tiers = [
      TerminalRefreshTier.FOCUSED,
      TerminalRefreshTier.BURST,
      TerminalRefreshTier.FOCUSED,
      TerminalRefreshTier.BACKGROUND,
      TerminalRefreshTier.VISIBLE,
    ];
    for (const tier of tiers) {
      simulateOnTierApplied("t-std", tier, stdManaged);
    }
    expect(webGLManager.isActive("t-std")).toBe(false);
  });

  it("mixed pool: standard terminals don't consume agent WebGL slots", () => {
    const agents = Array.from({ length: 3 }, (_, i) => ({
      id: `agent-${i}`,
      m: makeManagedTerminal("agent"),
    }));
    const stdManaged = makeManagedTerminal("terminal");

    for (const { id, m } of agents) {
      simulateOnTierApplied(id, TerminalRefreshTier.FOCUSED, m);
    }
    simulateOnTierApplied("t-std", TerminalRefreshTier.FOCUSED, stdManaged);

    for (const { id } of agents) {
      expect(webGLManager.isActive(id)).toBe(true);
    }
    expect(webGLManager.isActive("t-std")).toBe(false);
  });

  it("agent terminal refresh is called after WebGL release", () => {
    simulateOnTierApplied("t1", TerminalRefreshTier.FOCUSED, managed);
    expect(webGLManager.isActive("t1")).toBe(true);

    simulateOnTierApplied("t1", TerminalRefreshTier.BACKGROUND, managed);
    expect(webGLManager.isActive("t1")).toBe(false);
    expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("agent terminal refresh is NOT called when no WebGL was active", () => {
    // Never acquired WebGL, go to BACKGROUND
    simulateOnTierApplied("t1", TerminalRefreshTier.BACKGROUND, managed);
    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });
});
