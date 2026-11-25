import { useEffect } from "react";
import { offerHostSignIn } from "@/components/Settings/Hosts/hostSignInOffers";
import { openHostsSettingsTab } from "@/components/Settings/Hosts/hostSettingsRequests";

/**
 * Opens, in Settings → Hosts, an agent CLI sign-in Main started on a host for
 * the assistant this view shows (#18197), as the CLI's row there would. Only
 * Main sends these, to the view it chose; one that already ended is let be,
 * and one met by a sign-in already open here is refused there.
 */
export function useHostSignInOfferBridge(): void {
  useEffect(() => {
    const onEvent = window.electron?.canopyHost?.onEvent;
    if (!onEvent) return;
    return onEvent((event) => {
      if (event.kind !== "sign-in-offer") return;
      // Main ended it at this time; a push that arrived late opens nothing.
      if (Date.now() >= event.expiresAt) return;
      const accepted = offerHostSignIn({
        hostId: event.hostId,
        agentId: event.agentId,
        consumer: event.consumer,
        terminal: event.terminal,
        expiresAt: event.expiresAt,
      });
      if (accepted) openHostsSettingsTab();
    });
  }, []);
}
