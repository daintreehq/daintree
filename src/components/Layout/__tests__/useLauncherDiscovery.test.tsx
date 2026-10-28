// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AgentToolbarPins, CliAvailability } from "@shared/types";

// The discovery cue's whole job is to be truthful about what is new. Its rules
// interlock with `WelcomeScreen` (the two must never fire for the same agents)
// and with a TTL, so each branch is asserted rather than inferred.

let mockLoaded = true;
let mockSeenAgentIds: string[] = [];
let mockFirstSeen: Record<string, number> = {};
let mockWelcomeDismissed = true;
let mockAgentPins: AgentToolbarPins | null = {};
let mockHasRealData = true;

// The factory is hoisted, so the window is spelled inline here and read back
// through the import below — the fixtures below derive their timestamps from it
// rather than restating it.
vi.mock("@/hooks/app/useAgentDiscoveryOnboarding", () => ({
  NEW_AGENT_TTL_MS: 14 * 24 * 60 * 60 * 1000,
  useAgentDiscoveryOnboarding: () => ({
    loaded: mockLoaded,
    seenAgentIds: mockSeenAgentIds,
    availabilityFirstSeen: mockFirstSeen,
    welcomeCardDismissed: mockWelcomeDismissed,
    markAgentsSeen: vi.fn(),
    recordAgentFirstSeen: vi.fn(),
  }),
}));

// The real pins store, so "not loaded yet" is its own revision check rather
// than a restatement of it here.
function setPins(pins: AgentToolbarPins | null) {
  useAgentToolbarPinsStore.setState({ pins: pins ?? {}, revision: pins ? 0 : -1 });
}

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (selector: (s: { hasRealData: boolean }) => unknown) =>
    selector({ hasRealData: mockHasRealData }),
}));

import { useLauncherDiscovery } from "../useLauncherDiscovery";
import { useAgentToolbarPinsStore } from "@/store/agentToolbarPinsStore";
import { NEW_AGENT_TTL_MS as TTL } from "@/hooks/app/useAgentDiscoveryOnboarding";

const READY = { claude: "ready", gemini: "ready" } as unknown as CliAvailability;

function discover(availability: CliAvailability = READY) {
  setPins(mockAgentPins);
  return renderHook(() => useLauncherDiscovery(availability)).result.current;
}

beforeEach(() => {
  mockLoaded = true;
  mockSeenAgentIds = [];
  mockFirstSeen = {};
  mockWelcomeDismissed = true;
  mockAgentPins = { claude: true };
  mockHasRealData = true;
});

describe("useLauncherDiscovery", () => {
  it("flags a ready agent nobody has acted on yet", () => {
    const { newAgentIds, showDiscoveryBadge } = discover();
    expect(newAgentIds.has("gemini")).toBe(true);
    expect(showDiscoveryBadge).toBe(true);
  });

  it("counts only agents that can actually be launched", () => {
    const { newAgentIds, readyAgentIds } = discover({
      claude: "ready",
      gemini: "missing",
    } as unknown as CliAvailability);
    expect(readyAgentIds).toEqual(["claude"]);
    expect(newAgentIds.has("gemini")).toBe(false);
  });

  it("drops an agent from the cue once it has been seen", () => {
    mockSeenAgentIds = ["claude", "gemini"];
    expect(discover().showDiscoveryBadge).toBe(false);
  });

  it("decays the cue once an agent has been visible longer than the TTL", () => {
    mockFirstSeen = { claude: Date.now() - TTL - 1, gemini: Date.now() - TTL - 1 };
    expect(discover().showDiscoveryBadge).toBe(false);
  });

  it("keeps the cue for an agent first seen inside the TTL", () => {
    mockFirstSeen = { gemini: Date.now() - 1000 };
    expect(discover().newAgentIds.has("gemini")).toBe(true);
  });

  it("stays silent until onboarding state has loaded", () => {
    // Nothing is known yet, so nothing can honestly be called new.
    mockLoaded = false;
    expect(discover().showDiscoveryBadge).toBe(false);
  });

  it("yields to the welcome card while that card would actually render", () => {
    // Card is renderable: not dismissed, real data, ready agents, no pins. The
    // two must never fire for the same agents.
    mockWelcomeDismissed = false;
    mockAgentPins = {};
    expect(discover().showDiscoveryBadge).toBe(false);
  });

  it("still fires when the card is undismissed but a pin makes it ineligible", () => {
    // Pinning via the launcher or Settings leaves `welcomeCardDismissed` false.
    // Gating on the flag rather than on renderability would suppress Day-N
    // discovery for agents installed later.
    mockWelcomeDismissed = false;
    mockAgentPins = { claude: true };
    expect(discover().showDiscoveryBadge).toBe(true);
  });

  it("declares the card ineligible before the pins load, rather than claiming no pins", () => {
    mockWelcomeDismissed = false;
    mockAgentPins = null;
    // Mirrors WelcomeScreen's own `if (!agentPins) return false`.
    expect(discover().showDiscoveryBadge).toBe(true);
  });

  it("yields nothing before real availability data lands", () => {
    mockWelcomeDismissed = false;
    mockAgentPins = {};
    mockHasRealData = false;
    // The card is not renderable yet, so the badge is free to fire.
    expect(discover().showDiscoveryBadge).toBe(true);
  });
});
