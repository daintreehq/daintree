import { useEffect } from "react";
import { notify } from "@/lib/notify";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { MainProcessToastPayload } from "@shared/types/ipc/maps";
import { useDistributionStore } from "@/store/distributionStore";

const TRUSTED_EXTERNAL_HOST = "daintree.org";

/**
 * Narrow a main-process toast payload to a URL this hook is willing to hand to
 * the shell. Returns the normalized href, or null if anything about it is off.
 *
 * Rejects: non-HTTPS (no `http:`, no `file:`, no `javascript:`), embedded
 * credentials (`https://daintree.org@evil.test` — whose real host is the
 * attacker's), a non-default port, and lookalike hosts. The suffix test is
 * anchored on a leading dot so `notdaintree.org` and `daintree.org.evil.test`
 * both fail.
 */
function parseTrustedDaintreeUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host !== TRUSTED_EXTERNAL_HOST && !host.endsWith(`.${TRUSTED_EXTERNAL_HOST}`)) return null;
  return url.toString();
}

export function useMainProcessToastListener(): void {
  useEffect(() => {
    if (!window.electron?.notification?.onShowToast) return;

    const cleanup = window.electron.notification.onShowToast((payload: MainProcessToastPayload) => {
      const action = payload.action
        ? {
            label: payload.action.label,
            onClick: () => {
              const { ipcChannel, data } = payload.action!;
              if (ipcChannel === "update:check-for-updates") {
                if (useDistributionStore.getState().isWindowsStore) return;
                safeFireAndForget(window.electron.update.checkForUpdates(), {
                  context: "Checking for updates from toast action",
                });
              } else if (ipcChannel === "system:open-external") {
                // Main is the trusted sender, but this branch is the boundary
                // that turns a toast payload into a browser navigation — keep it
                // fail-closed and pinned to our own origin rather than trusting
                // whatever string arrived.
                const url = parseTrustedDaintreeUrl(data);
                if (!url) {
                  console.warn(
                    `[MainProcessToast] system:open-external rejected untrusted URL: ${data ?? "(missing)"}`
                  );
                  return;
                }
                safeFireAndForget(window.electron.system.openExternal(url), {
                  context: "Opening external URL from toast action",
                });
              } else if (ipcChannel === "clipboard:write-text") {
                // Guard against a main-process payload that forgot `data` —
                // silently clearing the clipboard would be a footgun.
                if (!data) {
                  console.warn("[MainProcessToast] clipboard:write-text missing data payload");
                  return;
                }
                safeFireAndForget(window.electron.clipboard.writeText(data), {
                  context: "Writing clipboard text from toast action",
                });
              } else {
                console.warn(`[MainProcessToast] Unknown IPC channel for action: ${ipcChannel}`);
              }
            },
          }
        : undefined;

      notify({
        type: payload.type,
        title: payload.title,
        message: payload.message,
        duration: payload.duration,
        rateLimitKey: payload.rateLimitKey,
        priority: payload.priority,
        action,
      });
    });

    return cleanup;
  }, []);
}
