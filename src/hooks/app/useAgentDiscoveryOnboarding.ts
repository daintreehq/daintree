import { useEffect } from "react";
import { create } from "zustand";
import type { OnboardingState } from "@shared/types";
import { isElectronAvailable } from "@/hooks/useElectron";

// Backstop for the per-row NEW indicator: agents whose first availability
// is older than this fall out of the discovery signal automatically, even
// if the user never launches them. Keeps the dot from becoming permanent
// background noise for users who don't engage with new agents.
export const NEW_AGENT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface AgentDiscoveryState {
  loaded: boolean;
  seenAgentIds: string[];
  availabilityFirstSeen: Record<string, number>;
  welcomeCardDismissed: boolean;
  setupBannerDismissed: boolean;
}

function normalizeAvailabilityFirstSeen(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === "string" && typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

const useAgentDiscoveryStore = create<AgentDiscoveryState>(() => ({
  loaded: false,
  seenAgentIds: [],
  availabilityFirstSeen: {},
  welcomeCardDismissed: false,
  setupBannerDismissed: false,
}));

let hydrating: Promise<void> | null = null;

async function hydrate(): Promise<void> {
  if (useAgentDiscoveryStore.getState().loaded) return;
  if (hydrating) return hydrating;

  hydrating = (async () => {
    if (!isElectronAvailable()) {
      useAgentDiscoveryStore.setState({ loaded: true });
      return;
    }
    const api = window.electron?.onboarding;
    if (!api?.get) {
      useAgentDiscoveryStore.setState({ loaded: true });
      return;
    }
    try {
      const state: OnboardingState = await api.get();
      useAgentDiscoveryStore.setState({
        loaded: true,
        seenAgentIds: Array.isArray(state.seenAgentIds) ? state.seenAgentIds : [],
        // Filter persisted timestamps to finite numbers. A corrupted entry
        // (NaN from an old build or hand-edited config) would otherwise leave
        // the discovery dot pinned forever — `Date.now() - NaN` is NaN, and
        // `NaN >= TTL` is false, so the TTL backstop wouldn't fire.
        availabilityFirstSeen: normalizeAvailabilityFirstSeen(state.availabilityFirstSeen),
        welcomeCardDismissed: state.welcomeCardDismissed === true,
        setupBannerDismissed: state.setupBannerDismissed === true,
      });
    } catch {
      useAgentDiscoveryStore.setState({ loaded: true });
    }
  })();

  try {
    await hydrating;
  } finally {
    hydrating = null;
  }
}

export async function markAgentsSeen(agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  useAgentDiscoveryStore.setState((s) => {
    const merged = new Set(s.seenAgentIds);
    let changed = false;
    for (const id of agentIds) {
      if (!merged.has(id)) {
        merged.add(id);
        changed = true;
      }
    }
    return changed ? { ...s, seenAgentIds: Array.from(merged) } : s;
  });
  const api = window.electron?.onboarding;
  if (!api?.markAgentsSeen) return;
  try {
    await api.markAgentsSeen(agentIds);
  } catch {
    // Best-effort; optimistic local state stands.
  }
}

export async function recordAgentFirstSeen(agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  useAgentDiscoveryStore.setState((s) => {
    const next = { ...s.availabilityFirstSeen };
    const now = Date.now();
    let changed = false;
    for (const id of agentIds) {
      // Idempotent: first write wins. The decay window is anchored on the
      // *first* time the agent was visibly available, not on each re-open.
      if (next[id] === undefined) {
        next[id] = now;
        changed = true;
      }
    }
    return changed ? { ...s, availabilityFirstSeen: next } : s;
  });
  const api = window.electron?.onboarding;
  if (!api?.recordAgentFirstSeen) return;
  try {
    await api.recordAgentFirstSeen(agentIds);
  } catch {
    // Best-effort; optimistic local state stands.
  }
}

export async function dismissWelcomeCard(): Promise<void> {
  if (useAgentDiscoveryStore.getState().welcomeCardDismissed) return;
  useAgentDiscoveryStore.setState({ welcomeCardDismissed: true });
  const api = window.electron?.onboarding;
  if (!api?.dismissWelcomeCard) return;
  try {
    await api.dismissWelcomeCard();
  } catch {
    // Best-effort; optimistic local state stands.
  }
}

export async function dismissSetupBanner(): Promise<void> {
  if (useAgentDiscoveryStore.getState().setupBannerDismissed) return;
  useAgentDiscoveryStore.setState({ setupBannerDismissed: true });
  const api = window.electron?.onboarding;
  if (!api?.dismissSetupBanner) return;
  try {
    await api.dismissSetupBanner();
  } catch {
    // Best-effort; optimistic local state stands.
  }
}

interface AgentDiscoveryOnboarding extends AgentDiscoveryState {
  markAgentsSeen: (agentIds: string[]) => Promise<void>;
  recordAgentFirstSeen: (agentIds: string[]) => Promise<void>;
  dismissWelcomeCard: () => Promise<void>;
  dismissSetupBanner: () => Promise<void>;
}

/**
 * Reads the discovery-related onboarding fields from a shared Zustand store
 * and exposes optimistic mutations. Hydration fires once on first mount and
 * is shared across all subscribers — critical for keeping the welcome card
 * (`WelcomeScreen`) and the tray badge (`AgentTrayButton`) in sync within a
 * session; see review on #5111.
 */
export function useAgentDiscoveryOnboarding(): AgentDiscoveryOnboarding {
  const loaded = useAgentDiscoveryStore((s) => s.loaded);
  const seenAgentIds = useAgentDiscoveryStore((s) => s.seenAgentIds);
  const availabilityFirstSeen = useAgentDiscoveryStore((s) => s.availabilityFirstSeen);
  const welcomeCardDismissed = useAgentDiscoveryStore((s) => s.welcomeCardDismissed);
  const setupBannerDismissed = useAgentDiscoveryStore((s) => s.setupBannerDismissed);

  useEffect(() => {
    void hydrate();
  }, []);

  return {
    loaded,
    seenAgentIds,
    availabilityFirstSeen,
    welcomeCardDismissed,
    setupBannerDismissed,
    markAgentsSeen,
    recordAgentFirstSeen,
    dismissWelcomeCard,
    dismissSetupBanner,
  };
}

export function resetAgentDiscoveryStoreForTests(): void {
  hydrating = null;
  useAgentDiscoveryStore.setState({
    loaded: false,
    seenAgentIds: [],
    availabilityFirstSeen: {},
    welcomeCardDismissed: false,
    setupBannerDismissed: false,
  });
}
