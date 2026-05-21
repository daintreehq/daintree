import { useEffect, useRef } from "react";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";

const GITHUB_TOKEN_SUPERSEDE_KEY = "github.token";

/**
 * Surfaces a high-priority notification when the repository-stats poll detects
 * a token-related GitHub error. The inline toolbar UI alone is invisible to
 * users who never open the GitHub panel; this hook escalates the same signal
 * to the toast/inbox surface so an expired or revoked token can't go unnoticed.
 *
 * Hysteresis latch: fires once on the false→true transition and re-arms when
 * the error clears, so successful re-auth and a future re-expiry both notify.
 * On the true→false recovery transition, emits a low-priority "Token validated"
 * inbox row carrying the same `supersedeKey` so the prior warning row archives
 * automatically and keyboard/screen-reader users get an explicit acknowledgement.
 */
export function useGitHubTokenExpiryNotification(isTokenError: boolean): void {
  const firedRef = useRef(false);
  const isUnhealthy = useGitHubTokenHealthStore((s) => s.isUnhealthy);

  useEffect(() => {
    if (isTokenError && isUnhealthy) {
      if (firedRef.current) return;
      firedRef.current = true;
      notify({
        type: "warning",
        priority: "high",
        title: "GitHub authentication required",
        message:
          "Your GitHub token isn't working. Reconnect in settings to restore issues, PRs, and stats.",
        correlationId: "github:token-expiry",
        supersedeKey: GITHUB_TOKEN_SUPERSEDE_KEY,
        coalesce: {
          key: "github:token-expiry",
          windowMs: 30000,
          buildMessage: () =>
            "Your GitHub token isn't working. Reconnect in settings to restore issues, PRs, and stats.",
        },
        action: {
          label: "Open GitHub settings",
          actionId: "app.settings.openTab",
          actionArgs: { tab: "code-forge", subtab: "github", sectionId: "github-token" },
          onClick: () => {
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "code-forge", subtab: "github", sectionId: "github-token" },
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
          supersedeKey: GITHUB_TOKEN_SUPERSEDE_KEY,
          title: "GitHub token validated",
          message: "Your GitHub token is working again.",
        });
      }
    }
  }, [isTokenError, isUnhealthy]);
}
