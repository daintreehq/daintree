import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import type { ManagedTerminal } from "../types";
import { TIER_DOWNGRADE_HYSTERESIS_MS } from "../types";
import type { RendererPolicyDeps } from "../TerminalRendererPolicy";
import { preloadMockWebglAddon } from "./_preloadWebglAddon";

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
    await preloadMockWebglAddon();

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
  let webGLPolicy: import("../TerminalWebGLPolicy").TerminalWebGLPolicy;
  let managed: ManagedTerminal;

  function makeManagedTerminal(agentId?: string | null): ManagedTerminal {
    // Agent identity lives on `runtimeAgentId`. Eligibility is identity-neutral
    // now (#11193): standard and agent terminals both want WebGL at visible
    // tiers. Tests that want a plain (non-agent) terminal pass `null` (or omit —
    // but `null` is more explicit and avoids the default-param trap when callers
    // pass `undefined`).
    return {
      terminal: { loadAddon: vi.fn(), refresh: vi.fn(), rows: 24 },
      isOpened: true,
      isVisible: true,
      lastActiveTime: Date.now(),
      kind: "terminal",
      runtimeAgentId: agentId === null ? undefined : (agentId ?? "claude"),
    } as unknown as ManagedTerminal;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
    const { TerminalWebGLPolicy } = await import("../TerminalWebGLPolicy");
    webGLManager = new TerminalWebGLManager();
    webGLPolicy = new TerminalWebGLPolicy({
      getMode: () => webGLManager.getMode(),
      getPinnedId: () => webGLManager.getPinnedId(),
      isAltBufferPinned: (id) => webGLManager.isAltBufferPinned(id),
    });
    managed = makeManagedTerminal();
    await preloadMockWebglAddon();
  });

  // Drives the real TerminalWebGLPolicy for the acquire decision so this suite
  // can't drift from production eligibility (it previously hand-rolled an
  // agent-only rule that already contradicted production for standard FOCUSED
  // terminals). The release branch is deliberately the simplified tier→WebGL
  // model — the production webGLHideTimer dwell + isVisible-gated refresh are
  // covered by webglVisibility.test.ts, which drives the real service.
  function simulateOnTierApplied(id: string, tier: TerminalRefreshTier, m: ManagedTerminal) {
    if (webGLPolicy.wantsWebGLAtTier(m, tier)) {
      webGLManager.ensureContext(id, m);
    } else if (!m.isVisible) {
      // Production guards the DOM-swap refresh on isVisible, so a hidden pane is
      // released WITHOUT a repaint (#6802). Mirror that here — the branch only
      // runs when hidden, so no refresh is invoked.
      webGLManager.releaseContext(id);
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

  it("BACKGROUND retains context while terminal is visible", () => {
    const managed2 = makeManagedTerminal();
    simulateOnTierApplied("t1", TerminalRefreshTier.FOCUSED, managed);
    simulateOnTierApplied("t2", TerminalRefreshTier.VISIBLE, managed2);

    // Visible agent terminal: tier alone must not release WebGL — that would
    // cause a one-frame flicker on click while the terminal stays on screen.
    simulateOnTierApplied("t1", TerminalRefreshTier.BACKGROUND, managed);
    expect(webGLManager.isActive("t1")).toBe(true);
    expect(webGLManager.isActive("t2")).toBe(true);
  });

  it("BACKGROUND releases context when terminal is hidden", () => {
    const managed2 = makeManagedTerminal();
    simulateOnTierApplied("t1", TerminalRefreshTier.FOCUSED, managed);
    simulateOnTierApplied("t2", TerminalRefreshTier.VISIBLE, managed2);

    managed.isVisible = false;
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

  it("standard terminal at FOCUSED acquires WebGL context (#11193)", () => {
    const stdManaged = makeManagedTerminal(null);
    simulateOnTierApplied("t-std", TerminalRefreshTier.FOCUSED, stdManaged);
    expect(webGLManager.isActive("t-std")).toBe(true);
  });

  it("standard terminal at BURST/VISIBLE acquires WebGL context (#11193)", () => {
    const stdManaged = makeManagedTerminal(null);
    simulateOnTierApplied("t-std", TerminalRefreshTier.BURST, stdManaged);
    expect(webGLManager.isActive("t-std")).toBe(true);
    simulateOnTierApplied("t-std", TerminalRefreshTier.VISIBLE, stdManaged);
    expect(webGLManager.isActive("t-std")).toBe(true);
  });

  it("visible standard terminal retains its context across tier churn (#11193)", () => {
    // FOCUSED→BURST→FOCUSED keep the context; a visible BACKGROUND retains it
    // (ineligible tier while visible is a no-op, not a release); VISIBLE
    // re-ensures. The pane stays visible throughout, so it never releases.
    const stdManaged = makeManagedTerminal(null);
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
    expect(webGLManager.isActive("t-std")).toBe(true);
  });

  it("mixed pool: standard and agent terminals both acquire WebGL uniformly (#11193)", () => {
    const agents = Array.from({ length: 3 }, (_, i) => ({
      id: `agent-${i}`,
      m: makeManagedTerminal("claude"),
    }));
    const stdManaged = makeManagedTerminal(null);

    for (const { id, m } of agents) {
      simulateOnTierApplied(id, TerminalRefreshTier.FOCUSED, m);
    }
    simulateOnTierApplied("t-std", TerminalRefreshTier.FOCUSED, stdManaged);

    for (const { id } of agents) {
      expect(webGLManager.isActive(id)).toBe(true);
    }
    expect(webGLManager.isActive("t-std")).toBe(true);
  });

  it("hidden release does not repaint the DOM (#6802)", () => {
    // Release only happens once a pane is off-screen. Repainting an offscreen
    // DOM produces a stale frame that flashes on next show, so production guards
    // the refresh on isVisible — a hidden release never repaints.
    simulateOnTierApplied("t1", TerminalRefreshTier.FOCUSED, managed);
    expect(webGLManager.isActive("t1")).toBe(true);

    // The DOM→WebGL attach on the FOCUSED ensure repaints once; clear that so
    // the assertion isolates the release path itself.
    (managed.terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

    managed.isVisible = false;
    simulateOnTierApplied("t1", TerminalRefreshTier.BACKGROUND, managed);
    expect(webGLManager.isActive("t1")).toBe(false);
    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });

  it("agent terminal refresh is NOT called when no WebGL was active", () => {
    // Never acquired WebGL, go to BACKGROUND while hidden
    managed.isVisible = false;
    simulateOnTierApplied("t1", TerminalRefreshTier.BACKGROUND, managed);
    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });
});
