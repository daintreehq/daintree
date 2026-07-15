import { describe, it, expect } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import type { ManagedTerminal } from "../types";
import { TerminalWebGLPolicy, type TerminalWebGLPolicyDeps } from "../TerminalWebGLPolicy";

// Direct coverage for the pure eligibility policy. This file changed three times
// under production incidents (#10671 want-set accumulation, the DOM-mode pinned
// context circuit breaker, bulk-attach staggering), so its decisions are worth
// pinning in isolation rather than only through the service integration suites.

function makeManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    id: "t1",
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isAttaching: false,
    runtimeAgentId: undefined,
    launchAgentId: undefined,
    lastAppliedTier: undefined,
    getRefreshTier: undefined,
    ...overrides,
  } as unknown as ManagedTerminal;
}

function makePolicy(deps: Partial<TerminalWebGLPolicyDeps> = {}): TerminalWebGLPolicy {
  return new TerminalWebGLPolicy({
    getMode: () => "webgl",
    getPinnedId: () => null,
    isAltBufferPinned: () => false,
    ...deps,
  });
}

const ELIGIBLE_TIERS = [
  TerminalRefreshTier.FOCUSED,
  TerminalRefreshTier.BURST,
  TerminalRefreshTier.VISIBLE,
] as const;

describe("TerminalWebGLPolicy.wantsWebGLAtTier", () => {
  it("is identity-neutral: standard and agent terminals both want WebGL at every eligible tier (#11193)", () => {
    const policy = makePolicy();
    for (const tier of ELIGIBLE_TIERS) {
      for (const runtimeAgentId of [undefined, "claude"]) {
        for (const isFocused of [true, false]) {
          const managed = makeManaged({ isVisible: true, runtimeAgentId, isFocused });
          expect(policy.wantsWebGLAtTier(managed, tier)).toBe(true);
        }
      }
    }
  });

  it("focus does not change the result — an unfocused visible standard terminal still wants WebGL", () => {
    const policy = makePolicy();
    const unfocusedStandard = makeManaged({
      isVisible: true,
      isFocused: false,
      runtimeAgentId: undefined,
    });
    expect(policy.wantsWebGLAtTier(unfocusedStandard, TerminalRefreshTier.VISIBLE)).toBe(true);
  });

  it("ineligible tiers (BACKGROUND, undefined) never want WebGL, even visible + focused + agent", () => {
    const policy = makePolicy();
    const managed = makeManaged({ isVisible: true, isFocused: true, runtimeAgentId: "claude" });
    expect(policy.wantsWebGLAtTier(managed, TerminalRefreshTier.BACKGROUND)).toBe(false);
    expect(policy.wantsWebGLAtTier(managed, undefined)).toBe(false);
  });

  it("off-screen terminals never want WebGL at any eligible tier — agent or standard (#10671)", () => {
    const policy = makePolicy();
    for (const tier of ELIGIBLE_TIERS) {
      for (const runtimeAgentId of [undefined, "claude"]) {
        const hidden = makeManaged({ isVisible: false, runtimeAgentId });
        expect(policy.wantsWebGLAtTier(hidden, tier)).toBe(false);
      }
    }
  });

  it("trustDomVisibility bypasses only the reactive visibility gate, not the tier gate", () => {
    const policy = makePolicy();
    const hidden = makeManaged({ isVisible: false, runtimeAgentId: undefined });

    // Warm-resume reveal proved visibility from DOM truth: an eligible tier wants WebGL.
    expect(
      policy.wantsWebGLAtTier(hidden, TerminalRefreshTier.VISIBLE, { trustDomVisibility: true })
    ).toBe(true);

    // But an ineligible tier is still rejected — trustDomVisibility is not a blanket override.
    expect(
      policy.wantsWebGLAtTier(hidden, TerminalRefreshTier.BACKGROUND, { trustDomVisibility: true })
    ).toBe(false);
  });
});

describe("TerminalWebGLPolicy.shouldHaveActiveWebGL — DOM-mode pin safety net", () => {
  // The watchdog must not treat a missing context as a fault for a non-pinned
  // pane while the fleet is in DOM-mode fallback (only pinned contexts stay
  // active). This safety net is identity-neutral and must survive #11193.
  const baseManaged = () =>
    makeManaged({
      id: "t1",
      isOpened: true,
      isVisible: true,
      isAttaching: false,
      lastAppliedTier: TerminalRefreshTier.VISIBLE,
      runtimeAgentId: undefined,
    });

  it("returns false for a non-pinned visible terminal while in DOM mode", () => {
    const policy = makePolicy({ getMode: () => "dom", getPinnedId: () => "other" });
    expect(policy.shouldHaveActiveWebGL(baseManaged())).toBe(false);
  });

  it("returns true for the focus-pinned terminal while in DOM mode", () => {
    const policy = makePolicy({ getMode: () => "dom", getPinnedId: () => "t1" });
    expect(policy.shouldHaveActiveWebGL(baseManaged())).toBe(true);
  });

  it("returns true for a visible eligible terminal in WebGL mode", () => {
    const policy = makePolicy({ getMode: () => "webgl" });
    expect(policy.shouldHaveActiveWebGL(baseManaged())).toBe(true);
  });
});
