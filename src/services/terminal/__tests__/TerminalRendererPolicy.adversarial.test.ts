import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@shared/types/panel";
import type { ManagedTerminal } from "../types";
import type { RendererPolicyDeps } from "../TerminalRendererPolicy";

vi.mock("@/clients", () => ({
  terminalClient: {
    setActivityTier: vi.fn(),
  },
}));

function createManagedTerminal(
  overrides: Partial<ManagedTerminal> = {}
): ManagedTerminal & { terminal: { refresh: ReturnType<typeof vi.fn>; rows: number } } {
  return {
    lastActiveTime: 0,
    lastAppliedTier: TerminalRefreshTier.FOCUSED,
    getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    pendingTier: undefined,
    tierChangeTimer: undefined,
    terminal: {
      refresh: vi.fn(),
      rows: 24,
    },
    ...overrides,
  } as ManagedTerminal & { terminal: { refresh: ReturnType<typeof vi.fn>; rows: number } };
}

// Hibernation removed: the background→active transition is a synchronous plain
// repaint (refresh + onPostWake + onResumeFlush). There is no async wake, no
// wake-generation gating, and no discard path. These adversarial cases cover the
// tier-dedupe / hysteresis-timer machinery that stays, plus the repaint path.
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

  it("CHURN_COLLAPSES_TO_LAST_TIER", async () => {
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
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

  it("BACKGROUND_SEEDED_TERMINAL_REPAINTS_AND_FLUSHES_ON_FIRST_ACTIVATION", async () => {
    // Mirrors the initial-BACKGROUND wiring: TerminalInstanceService seeds the
    // backend tier via initializeBackendTier("id","background") so the first
    // promotion is a real BACKGROUND→active transition. With hibernation removed
    // that transition is a synchronous plain repaint that releases held bytes via
    // onResumeFlush — there is no snapshot replay and no discard path.
    const managed = createManagedTerminal({
      lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    });
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
      onResumeFlush: vi.fn(),
      onPostWake: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);
    policy.initializeBackendTier("terminal-1", "background");

    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.FOCUSED);

    expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(deps.onPostWake).toHaveBeenCalledWith("terminal-1");
    expect(deps.onResumeFlush).toHaveBeenCalledWith("terminal-1");
  });

  it("REBACKGROUND_AFTER_FOREGROUND_DOES_NOT_REPAINT_AGAIN", async () => {
    const managed = createManagedTerminal({
      lastAppliedTier: TerminalRefreshTier.BACKGROUND,
      getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    });
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
      onResumeFlush: vi.fn(),
      onPostWake: vi.fn(),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const policy = new TerminalRendererPolicy(deps);
    policy.initializeBackendTier("terminal-1", "background");

    // BACKGROUND→FOCUSED repaints exactly once (synchronously).
    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.FOCUSED);
    expect(managed.terminal.refresh).toHaveBeenCalledTimes(1);
    expect(deps.onResumeFlush).toHaveBeenCalledTimes(1);

    vi.mocked(managed.terminal.refresh).mockClear();
    vi.mocked(deps.onResumeFlush!).mockClear();
    vi.mocked(deps.onPostWake!).mockClear();

    // Re-backgrounding (active→background) must NOT run the repaint/flush path —
    // that only fires on background→active.
    managed.getRefreshTier = () => TerminalRefreshTier.BACKGROUND;
    policy.applyRendererPolicy("terminal-1", TerminalRefreshTier.BACKGROUND);
    vi.advanceTimersByTime(1000);

    expect(managed.terminal.refresh).not.toHaveBeenCalled();
    expect(deps.onPostWake).not.toHaveBeenCalled();
    expect(deps.onResumeFlush).not.toHaveBeenCalled();
  });

  it("HOST_PUSHED_BACKGROUND_REARMS_DEDUPE_SO_NEXT_ACTIVE_RESENDS", async () => {
    // Issue #9778 / lesson #8998 (same-tier no-op trap): when the PTY host
    // silently demotes a terminal to "background" via recomputeActivityTiers,
    // it pushes a tier-changed message that the renderer applies through
    // initializeBackendTier. That MUST re-arm the outbound dedupe baseline so a
    // subsequent "active" is actually resent to the host instead of being
    // dropped as a redundant same-tier call — which is exactly what left the
    // producer gate suppressing bytes while the pane looked active.
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const { terminalClient } = await import("@/clients");
    const policy = new TerminalRendererPolicy(deps);

    // Renderer's last outbound tier is "active".
    policy.setBackendTier("terminal-1", "active");
    expect(terminalClient.setActivityTier).toHaveBeenCalledTimes(1);

    // Re-sending "active" without any intervening change dedupes (proves the
    // trap exists — this is the no-op that would strand a host-demoted terminal).
    policy.setBackendTier("terminal-1", "active");
    expect(terminalClient.setActivityTier).toHaveBeenCalledTimes(1);

    // Host-pushed demotion arrives over the MessagePort and re-arms the baseline.
    policy.initializeBackendTier("terminal-1", "background");

    // Now the renderer reactivating sends a real "active" to the host again.
    policy.setBackendTier("terminal-1", "active");
    expect(terminalClient.setActivityTier).toHaveBeenCalledTimes(2);
    expect(terminalClient.setActivityTier).toHaveBeenLastCalledWith(
      "terminal-1",
      "active",
      undefined
    );
  });

  it("DEDUPE_SEQUENCE_COLLAPSES_REDUNDANT_ACTIVE_TO_TWO_HOST_CALLS (#9799)", async () => {
    // Folded in from closed issue #9799. A renderer-side burst of
    // active→active→background outbound tier sets must reach the host as
    // exactly TWO setActivityTier calls, not three: the second "active" is a
    // same-tier no-op that setBackendTier's dedupe (lastBackendTier ===
    // incoming tier) swallows. Proving the count is 2 (derived from the 3-call
    // input minus the 1 deduped call) is a behavioral assertion — it fails if
    // the dedupe is removed (3 calls) or if a real transition is wrongly
    // dropped (1 call). The exact arg sequence proves WHICH call was collapsed.
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const { terminalClient } = await import("@/clients");
    const policy = new TerminalRendererPolicy(deps);

    policy.setBackendTier("terminal-1", "active"); // real: undefined → active
    policy.setBackendTier("terminal-1", "active"); // deduped: active → active
    policy.setBackendTier("terminal-1", "background"); // real: active → background

    const calls = vi.mocked(terminalClient.setActivityTier).mock.calls;
    expect(calls).toHaveLength(2);
    // The surviving calls are the two real transitions, in order — the
    // duplicate "active" is absent.
    expect(calls.map((c) => c[1])).toEqual(["active", "background"]);
  });

  it("HOST_PUSHED_TIER_AND_RENDERER_CACHE_AGREE_AFTER_EACH_TRANSITION (#9798)", async () => {
    // Folded in from closed issue #9798. The renderer's cached view of the
    // backend tier (getLastBackendTier) must never diverge from the tier it
    // last agreed with the host on. Two directions of agreement:
    //   1. host→renderer: a host-pushed tier (initializeBackendTier, the
    //      tier-changed message from recomputeActivityTiers) is reflected by
    //      getLastBackendTier with no outbound call.
    //   2. renderer→host: a renderer-driven setBackendTier ships a value to
    //      the host that is byte-for-byte the same value getLastBackendTier
    //      then reports — the cache and the wire never disagree.
    const managed = createManagedTerminal();
    const deps: RendererPolicyDeps = {
      getInstance: vi.fn(() => managed),
    };

    const { TerminalRendererPolicy } = await import("../TerminalRendererPolicy");
    const { terminalClient } = await import("@/clients");
    const policy = new TerminalRendererPolicy(deps);

    // host→renderer: a host demotion seeds the cache without an outbound call.
    policy.initializeBackendTier("terminal-1", "background");
    expect(policy.getLastBackendTier("terminal-1")).toBe("background");
    expect(terminalClient.setActivityTier).not.toHaveBeenCalled();

    // renderer→host: the value sent to the host equals the value the cache
    // then reports — they agree, no divergence.
    policy.setBackendTier("terminal-1", "active");
    const sentTier = vi.mocked(terminalClient.setActivityTier).mock.calls.at(-1)?.[1];
    expect(sentTier).toBe(policy.getLastBackendTier("terminal-1"));
    expect(policy.getLastBackendTier("terminal-1")).toBe("active");
  });
});
