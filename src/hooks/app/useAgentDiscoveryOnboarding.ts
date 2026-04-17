import { useEffect } from "react";
import { create } from "zustand";
import type { OnboardingState } from "@shared/types";
import { isElectronAvailable } from "@/hooks/useElectron";

interface AgentDiscoveryState {
  loaded: boolean;
  seenAgentIds: string[];
  welcomeCardDismissed: boolean;
  setupBannerDismissed: boolean;
}

const useAgentDiscoveryStore = create<AgentDiscoveryState>(() => ({
  loaded: false,
  seenAgentIds: [],
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
  const welcomeCardDismissed = useAgentDiscoveryStore((s) => s.welcomeCardDismissed);
  const setupBannerDismissed = useAgentDiscoveryStore((s) => s.setupBannerDismissed);

  useEffect(() => {
    void hydrate();
  }, []);

  return {
    loaded,
    seenAgentIds,
    welcomeCardDismissed,
    setupBannerDismissed,
    markAgentsSeen,
    dismissWelcomeCard,
    dismissSetupBanner,
  };
}

export function resetAgentDiscoveryStoreForTests(): void {
  hydrating = null;
  useAgentDiscoveryStore.setState({
    loaded: false,
    seenAgentIds: [],
    welcomeCardDismissed: false,
    setupBannerDismissed: false,
  });
}
