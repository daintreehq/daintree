import { useEffect } from "react";
import { notify } from "@/lib/notify";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { ClientAppError } from "@/utils/clientAppError";
import type { MainProcessToastPayload } from "@shared/types/ipc/maps";
import { useDistributionStore } from "@/store/distributionStore";
import { actionService } from "@/services/ActionService";
import type { NotificationAction } from "@/store/notificationStore";
import type { ActionId } from "@shared/types/actions";

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

/** `{ hostId, projectId }` from a toast action's data, or null when it isn't one. */
function parseHostProjectTarget(
  raw: string | undefined
): { hostId: string; projectId: string } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { hostId, projectId } = parsed as { hostId?: unknown; projectId?: unknown };
    if (typeof hostId !== "string" || hostId.length === 0) return null;
    if (typeof projectId !== "string" || projectId.length === 0) return null;
    return { hostId, projectId };
  } catch {
    return null;
  }
}

/**
 * A switch main ran (a window put back on its host at launch) that failed,
 * shown by the same presenter as every other entry point so the same failure
 * offers the same recovery.
 */
function presentHostSwitchFailure(
  payload: MainProcessToastPayload,
  failure: NonNullable<MainProcessToastPayload["hostSwitchFailure"]>
): void {
  const { hostId, projectId, code } = failure;
  const error = new ClientAppError(code ?? "HOST_DISCONNECTED", payload.message, payload.message);
  safeFireAndForget(
    import("@/components/Hosts/hostSwitching").then(({ notifyHostSwitchFailure, switchToHost }) =>
      notifyHostSwitchFailure(
        hostId,
        error,
        () => void switchToHost(hostId, false, projectId),
        payload.title ? { title: payload.title } : undefined
      )
    ),
    { context: "Showing a failed host switch from main" }
  );
}

/**
 * Buttons for a plugin's `host.notify` (#13505). Main held each action to the
 * plugin's own namespace before sending it. A click is the user's, so the
 * action runs with the user's source, as the same plugin's toolbar button
 * would; `successLabel` stays unset because a resolved dispatch says nothing
 * about what the plugin's handler then did.
 */
function toPluginNotificationActions(
  pluginActions: NonNullable<MainProcessToastPayload["pluginActions"]>
): NotificationAction[] {
  return pluginActions.map((action, index) => ({
    label: action.label,
    variant: index === 0 ? "primary" : "secondary",
    actionId: action.actionId as ActionId,
    ...(action.args !== undefined ? { actionArgs: action.args } : {}),
    onClick: async () => {
      const result = await actionService.dispatch(action.actionId as ActionId, action.args, {
        source: "user",
      });
      if (!result.ok) {
        console.warn(
          `[MainProcessToast] plugin notification action "${action.actionId}" failed:`,
          result.error
        );
      }
    },
  }));
}

export function useMainProcessToastListener(): void {
  useEffect(() => {
    if (!window.electron?.notification?.onShowToast) return;

    const cleanup = window.electron.notification.onShowToast((payload: MainProcessToastPayload) => {
      if (payload.hostSwitchFailure) {
        presentHostSwitchFailure(payload, payload.hostSwitchFailure);
        return;
      }
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
                // fail-closed and pinned to our own domain rather than trusting
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
              } else if (ipcChannel === "remote-hosts:switch-window-host") {
                // Retry for a window main couldn't put back on its host at launch.
                const target = parseHostProjectTarget(data);
                if (!target) {
                  console.warn("[MainProcessToast] remote-hosts:switch-window-host bad payload");
                  return;
                }
                safeFireAndForget(
                  import("@/components/Hosts/hostSwitching").then(({ switchToHost }) =>
                    switchToHost(target.hostId, false, target.projectId)
                  ),
                  { context: "Reopening a window on its host from toast action" }
                );
              } else {
                console.warn(`[MainProcessToast] Unknown IPC channel for action: ${ipcChannel}`);
              }
            },
          }
        : undefined;

      const pluginActions =
        payload.pluginActions && payload.pluginActions.length > 0
          ? toPluginNotificationActions(payload.pluginActions)
          : undefined;

      notify({
        type: payload.type,
        title: payload.title,
        message: payload.message,
        duration: payload.duration,
        rateLimitKey: payload.rateLimitKey,
        priority: payload.priority,
        action,
        ...(pluginActions ? { actions: pluginActions, urgent: false } : {}),
        ...(payload.replaceKey !== undefined ? { replaceKey: payload.replaceKey } : {}),
      });
    });

    return cleanup;
  }, []);
}
