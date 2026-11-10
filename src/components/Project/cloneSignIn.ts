import { LogIn } from "lucide-react";
import type { BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { actionService } from "@/services/ActionService";
import { matchProviderForRemoteUrl } from "@shared/utils/forgeHostnames";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";

export interface CloneForgeProvider {
  providerId: string;
  name: string;
  hostnames: string[];
}

/** The registered forge providers, best-effort: a failed read is an empty list. */
export async function loadCloneForgeProviders(): Promise<CloneForgeProvider[]> {
  try {
    const entries = await window.electron.forge.getProviders();
    return entries.map((entry) => ({
      providerId: makeForgeProviderId(entry.pluginId, entry.contribution.id),
      name: entry.contribution.name,
      hostnames: entry.contribution.matches,
    }));
  } catch {
    return [];
  }
}

/**
 * The provider sign-in is a failed clone's banner action only when the URL
 * actually belongs to a registered forge; otherwise Retry is the sole
 * recovery, so the two never offer competing answers to the same failure.
 */
export function buildCloneSignInAction(
  remoteUrl: string,
  providers: readonly CloneForgeProvider[]
): BannerAction | null {
  const matchedProviderId = matchProviderForRemoteUrl(remoteUrl, providers);
  if (matchedProviderId === null) return null;
  const matchedProvider = providers.find((p) => p.providerId === matchedProviderId);
  if (!matchedProvider) return null;
  return {
    id: "signin-forge-provider",
    label: `Sign in to ${matchedProvider.name}`,
    icon: LogIn,
    // Neutral chip, not the info-tinted `accent`: inside a red banner that
    // variant rendered dimmer than the prose it was meant to resolve.
    variant: "primary",
    onClick: () => {
      void actionService.dispatch(
        "app.settings.openTab",
        { tab: "code-forge", subtab: matchedProvider.providerId },
        { source: "user" }
      );
    },
    title: `Open ${matchedProvider.name} sign-in`,
    ariaLabel: `Sign in to ${matchedProvider.name}`,
  };
}
