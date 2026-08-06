import { useMemo } from "react";
import {
  useAgentDiscoveryOnboarding,
  NEW_AGENT_TTL_MS,
} from "@/hooks/app/useAgentDiscoveryOnboarding";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import { isAgentPinned } from "@shared/utils/agentPinned";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import type { CliAvailability } from "@shared/types";

export interface LauncherDiscovery {
  /** Agents detected recently enough to still wear the "New" cue. */
  newAgentIds: ReadonlySet<string>;
  /** Whether the launcher trigger wears the discovery dot. */
  showDiscoveryBadge: boolean;
  /** Every agent that can be launched right now. */
  readyAgentIds: string[];
  markAgentsSeen: (ids: string[]) => Promise<void> | void;
  recordAgentFirstSeen: (ids: string[]) => Promise<void> | void;
}

/**
 * The launcher's half of first-run agent discovery.
 *
 * Extracted from the component so both launcher placements compute the cue the
 * same way — the badge's whole job is to be truthful about what is new, and two
 * surfaces deriving "new" separately is how they start disagreeing.
 */
export function useLauncherDiscovery(agentAvailability?: CliAvailability): LauncherDiscovery {
  const {
    loaded: onboardingLoaded,
    seenAgentIds,
    availabilityFirstSeen,
    welcomeCardDismissed,
    markAgentsSeen,
    recordAgentFirstSeen,
  } = useAgentDiscoveryOnboarding();
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const hasRealData = useCliAvailabilityStore((s) => s.hasRealData);

  const readyAgentIds = useMemo(
    () => LAUNCHABLE_AGENT_IDS.filter((id) => isAgentLaunchable(agentAvailability?.[id])),
    [agentAvailability]
  );

  // Deliberately `isAgentPinned`, not the array-aware toolbar predicate the pin
  // affordance reads. This has to mirror `WelcomeScreen`'s own render predicate
  // exactly, which still asks about explicit pins — the two exist to keep the
  // card and the discovery badge from both firing for the same agents, so the
  // moment they disagree a grandfathered profile gets both.
  const hasNoPinnedAgents = useMemo(() => {
    // `false` when settings haven't loaded, matching `WelcomeScreen`'s own
    // `if (!agentSettings) return false` — it declares the card ineligible, so
    // claiming "no pins" here would suppress the badge for a card that is never
    // going to render.
    if (!agentSettings) return false;
    if (!agentSettings.agents) return true;
    return !LAUNCHABLE_AGENT_IDS.some((id) => isAgentPinned(agentSettings.agents?.[id]));
  }, [agentSettings]);

  // While the first-run welcome card is actually being rendered, suppress the
  // launcher discovery badge so the card and badge don't both fire for the same
  // agents. Gated on whether the card would render right now — not on the
  // dismiss flag — so a user who pins via the launcher or Settings (which
  // leaves `welcomeCardDismissed: false`) still gets Day-N discovery for agents
  // installed later.
  const welcomeCardRenderable =
    onboardingLoaded &&
    hasRealData &&
    !welcomeCardDismissed &&
    readyAgentIds.length > 0 &&
    hasNoPinnedAgents;

  const newAgentIds = useMemo<ReadonlySet<string>>(() => {
    if (!onboardingLoaded || welcomeCardRenderable) return new Set<string>();
    const set = new Set<string>();
    // Snapshot Date.now() once per memo so all agents share a single cutoff for
    // this render. The visibilitychange refresh already re-renders on app
    // resume, so a stale `now` can't outlive a session.
    const now = Date.now();
    for (const id of readyAgentIds) {
      if (seenAgentIds.includes(id)) continue;
      const firstSeen = availabilityFirstSeen[id];
      if (firstSeen !== undefined && now - firstSeen >= NEW_AGENT_TTL_MS) continue;
      set.add(id);
    }
    return set;
  }, [onboardingLoaded, welcomeCardRenderable, readyAgentIds, seenAgentIds, availabilityFirstSeen]);

  return {
    newAgentIds,
    showDiscoveryBadge: newAgentIds.size > 0,
    readyAgentIds,
    markAgentsSeen,
    recordAgentFirstSeen,
  };
}
