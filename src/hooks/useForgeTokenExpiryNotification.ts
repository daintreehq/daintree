import { useEffect, useRef } from "react";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { useProjectStore } from "@/store/projectStore";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { forgeTokenSupersedeKey } from "@/hooks/useForgeTokenHealth";

/**
 * Surfaces a high-priority notification when the repository-stats poll detects
 * a token-related forge error. The inline toolbar UI alone is invisible to
 * users who never open the forge panel; this hook escalates the same signal
 * to the toast/inbox surface so an expired or revoked token can't go unnoticed.
 *
 * Hysteresis latch: fires once on the false→true transition and re-arms when
 * the error clears, so successful re-auth and a future re-expiry both notify.
 * On the true→false recovery transition, emits a low-priority "Token validated"
 * inbox row carrying the same `supersedeKey` so the prior warning row archives
 * automatically and keyboard/screen-reader users get an explicit acknowledgement.
 */
export function useForgeTokenExpiryNotification(isTokenError: boolean): void {
  const firedRef = useRef(false);
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const { entry, providerId } = useResolvedForgeProvider(projectId);
  const isUnhealthy = useForgeProviderHealthStore((s) =>
    providerId ? (s.providers[providerId]?.tokenUnhealthy ?? false) : false
  );
  const providerName = entry?.contribution.name ?? null;

  useEffect(() => {
    if (!providerId) return;
    const name = providerName ?? providerId;
    const supersedeKey = forgeTokenSupersedeKey(providerId);

    if (isTokenError && isUnhealthy) {
      if (firedRef.current) return;
      firedRef.current = true;
      const message = `Your ${name} token isn't working. Reconnect in settings to restore issues, PRs, and stats.`;
      notify({
        type: "warning",
        priority: "high",
        title: `${name} authentication required`,
        message,
        correlationId: `forge:token-expiry:${providerId}`,
        supersedeKey,
        context: { eventKind: "connectivity" },
        coalesce: {
          key: `forge:token-expiry:${providerId}`,
          windowMs: 30000,
          buildMessage: () => message,
        },
        action: {
          label: `Open ${name} settings`,
          actionId: "app.settings.openTab",
          actionArgs: { tab: "code-forge", subtab: providerId },
          onClick: () => {
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "code-forge", subtab: providerId },
              { source: "user" }
            );
          },
        },
      });
    } else if (firedRef.current) {
      const isResolved = !isTokenError;
      firedRef.current = false;
      // Only emit the recovery row when the caller's `isTokenError` signal
      // actually clears. When only `isUnhealthy` drops (a health-store race or
      // independent recovery) while `isTokenError` is still true, the token
      // hasn't truly recovered — silently re-arm the latch so the next
      // unhealthy event re-fires the warning, but don't show a stale
      // "validated" confirmation.
      if (isResolved) {
        notify({
          type: "success",
          priority: "low",
          supersedeKey,
          title: `${name} token validated`,
          message: `Your ${name} token is working again.`,
          context: { eventKind: "connectivity" },
        });
      }
    }
  }, [isTokenError, isUnhealthy, providerId, providerName]);
}
