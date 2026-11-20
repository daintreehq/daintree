import type { DecisionsHostsResult } from "@shared/types/decisionsHosts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { decisionsClient } from "@/clients/decisionsClient";
import { readDecisionsSwitch } from "@/hooks/useDecisionsOn";
import { currentHostId, getHostPlatformInfo, isRemoteWindow } from "@/hooks/useHostPlatform";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import type { NotificationAction } from "@/store/notificationStore";

/**
 * Why a Remote Host's questions aren't in this computer's inbox, from what
 * main last observed of it (#18049); null when they are. `name` is how the
 * window knows the Host, for a Host the host list doesn't name.
 */
export function hostInboxRefusal(
  read: DecisionsHostsResult,
  hostId: string,
  name: string
): string | null {
  if (read.inboxHostIds?.includes(hostId) === true) return null;
  if (read.result === "not-set-up") {
    return `This computer has no Decisions relay identity to enroll Hosts with, and its inbox doesn't list ${name}'s questions.`;
  }
  const host = read.hosts.find((candidate) => candidate.hostId === hostId);
  const shown = host?.name ?? name;
  const notListed = "so this computer's inbox doesn't list its questions.";
  switch (host?.enrollment.state) {
    case "not-enrolled":
      return `${shown} isn't enrolled in Decisions, ${notListed}`;
    case "revoked":
      return `${shown}'s Decisions device was revoked, ${notListed}`;
    case "stale":
      return `${shown} holds Decisions keys this computer's relay no longer lists, ${notListed}`;
    case "own-setup":
      return `${shown} has its own Decisions setup, ${notListed}`;
    case "other-setup":
      return `${shown} is enrolled with another relay or owner, ${notListed}`;
    case "needs-update":
      return `${shown} needs a newer Daintree to be enrolled in Decisions, ${notListed}`;
    case "failed":
      return `${shown}'s last Decisions enrollment didn't finish, and this computer's inbox doesn't list its questions.`;
    default:
      // Not checked or enrolled yet, enrolled with no report of its questions taken, or a report main set aside.
      return `This computer's inbox doesn't list ${shown}'s Decisions questions now.`;
  }
}

/** The inbox doesn't hold this window's questions: the message says why. */
export class HostInboxRefused extends Error {
  override name = "HostInboxRefused";
}

/** Whether the person is shown a failure, or the caller is: an agent reads the result alone. */
export interface DecisionsOpenCaller {
  quiet: boolean;
}

/**
 * Settles that this computer's inbox holds this window's questions: always
 * in its own windows, and in a Remote Host's or WSL distro's only while main
 * lists its Host's (#18049), asked afresh each time. Throws
 * {@link HostInboxRefused} when it doesn't, and an ordinary error when main
 * couldn't be asked.
 */
export async function requireHostInbox(): Promise<void> {
  if (!isRemoteWindow()) return;
  const name = getHostPlatformInfo().hostName ?? "This Host";
  let read: DecisionsHostsResult;
  try {
    read = await decisionsClient.listHosts();
  } catch (error) {
    throw new Error(
      `This computer couldn't tell whether ${name}'s questions are in its inbox. ${formatErrorMessage(error, "Its Remote Hosts couldn't be read.")}`,
      { cause: error }
    );
  }
  const refusal = hostInboxRefusal(read, currentHostId(), name);
  if (refusal !== null) throw new HostInboxRefused(refusal);
}

/** Settings shows each Host's enrollment, and Enroll for one that can be. */
const HOST_SETTINGS = { tab: "decisions", sectionId: "decisions-hosts" };

/**
 * Says once why a Decisions view didn't open, titled `title`, unless the
 * caller is quiet, then throws it, so the dispatch reports it failed. A
 * refusal offers the Hosts in Settings; anything else, `retry`. Urgent: it
 * answers the person's own press, which quiet hours mustn't hold back.
 */
export function failToOpen(
  error: unknown,
  title: string,
  caller: DecisionsOpenCaller,
  retry: NotificationAction
): never {
  const refused = error instanceof HostInboxRefused;
  const message = refused
    ? error.message
    : formatErrorMessage(error, "The Decisions questions couldn't be read.");
  if (!caller.quiet) {
    notify({
      type: "error",
      priority: "high",
      urgent: true,
      title,
      message,
      context: { eventKind: "settings" },
      action: refused
        ? {
            label: "Open Decisions settings",
            actionId: "app.settings.openTab",
            actionArgs: HOST_SETTINGS,
            onClick: () => {
              void actionService.dispatch("app.settings.openTab", HOST_SETTINGS, {
                source: "user",
              });
            },
          }
        : retry,
    });
  }
  throw refused ? error : new Error(message);
}

/**
 * Opens the inbox, at a pane's question when `terminalId` names one, once it
 * is known to hold this window's questions. In this computer's own windows it
 * opens before this returns. Rejects with the failure it reported.
 */
export async function openDecisionsInbox(
  request: { terminalId?: string | null } | undefined,
  caller: DecisionsOpenCaller
): Promise<void> {
  try {
    if (isRemoteWindow()) {
      await requireHostInbox();
      // Switched off while main was asked: nothing it holds is still asked.
      if (readDecisionsSwitch() !== "on") return;
    }
    useDecisionsInboxStore.getState().open(request);
  } catch (error) {
    failToOpen(error, "Couldn't open Decisions inbox", caller, {
      label: "Try again",
      actionId: "decisions.openInbox",
      onClick: () => {
        openDecisionsInbox(request, caller).catch(() => {});
      },
    });
  }
}
