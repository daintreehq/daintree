import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import {
  useForgeProviderHealthStore,
  type ForgeProviderHealth,
} from "@/store/forgeProviderHealthStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

/**
 * The provider this banner would show, or `undefined`. Shared with the
 * coordinator so the slot is claimed by exactly the condition that renders:
 * a dismissed or disabled-plugin provider must not hold an empty band and
 * suppress the banners beneath it.
 */
export function selectActiveForgeTokenProvider(
  providers: Record<string, ForgeProviderHealth>,
  disabledPluginIds: ReadonlySet<string>
): [providerId: string, health: ForgeProviderHealth] | undefined {
  return Object.entries(providers).find(
    ([, health]) =>
      health.tokenUnhealthy &&
      !health.tokenBannerDismissed &&
      (health.pluginId === null || !disabledPluginIds.has(health.pluginId))
  );
}

export function ForgeTokenBanner() {
  const providers = useForgeProviderHealthStore((s) => s.providers);
  const dismissTokenBanner = useForgeProviderHealthStore((s) => s.dismissTokenBanner);
  // A disabled plugin's provider must not warn about its token expiring — the
  // integration is off, so there's nothing to reconnect. The runtime mirror
  // drops the banner live when the owning plugin is toggled off.
  const disabledPluginIds = usePluginRuntimeStore((s) => s.disabledPluginIds);
  const init = usePluginRuntimeStore((s) => s.init);
  useEffect(() => init(), [init]);

  const active = selectActiveForgeTokenProvider(providers, disabledPluginIds);
  if (!active) return null;

  const [providerId, health] = active;
  const name = health.providerName ?? providerId;
  const reauthUrl = health.tokenHealth?.reauthUrl;

  const handleReconnect = () => {
    // Route through the action service to the provider's own settings panel —
    // matches every other recovery entry point. Use the canonical provider id
    // for `subtab` to match the standardized forge routing.
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "code-forge", subtab: providerId },
      { source: "user" }
    );
  };

  const actions: BannerAction[] = [
    {
      id: "reconnect",
      label: `Reconnect to ${name}`,
      variant: "primary",
      onClick: handleReconnect,
    },
  ];
  if (reauthUrl) {
    actions.push({
      id: "reauthorize",
      label: "Open reauthorization page",
      variant: "dismiss",
      onClick: () => {
        void actionService.dispatch("system.openExternal", { url: reauthUrl }, { source: "user" });
      },
    });
  }

  return (
    <InlineStatusBanner
      title={`${name} token expired`}
      description="Reconnect to restore issue, PR, and repository data."
      severity="warning"
      role="status"
      onClose={() => dismissTokenBanner(providerId)}
      closeAriaLabel={`Dismiss ${name} token warning`}
      actions={actions}
    />
  );
}
