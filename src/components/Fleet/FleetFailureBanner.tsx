import { type ReactElement, useEffect, useState } from "react";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { actionService } from "@/services/ActionService";
import {
  confirmCrossHostResend,
  crossHostSafeRetryDeadline,
  getCrossHostTarget,
} from "./crossHostFleet";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function retryFailures(): void {
  void actionService.dispatch("fleet.retryFailures", undefined, { source: "user" });
}

/**
 * Tier-2 inline banner that surfaces partial fleet broadcast failures.
 * Sits above the fleet ribbon (#8705) — the Tier-1 per-pane red dots are
 * still drawn by `PanelHeader`, but a multi-terminal failure escalates one
 * tier per CLAUDE.md to make sure the user notices that *some* targets
 * dropped the write.
 *
 * The action is omitted (not disabled) when `payload === null` — single
 * keystrokes aren't meaningful to replay, and a native disabled button
 * with a Radix tooltip silently fails to show the explanation on Chromium.
 *
 * Another host's agent whose submit was never confirmed is safe to retry only
 * while its host still holds the submit's record. Once that window passes it
 * reads as unconfirmed, Retry leaves it out, and sending to it again takes an
 * explicit confirmation naming the risk of a second copy.
 */
export function FleetFailureBanner(): ReactElement | null {
  const failedIds = useFleetFailureStore((s) => s.failedIds);
  const payload = useFleetFailureStore((s) => s.payload);
  // Snapshotted alongside the failure record (same broadcast), so a mixed
  // outcome names both halves — what's retryable here vs. what was already
  // disarmed as unreachable — without cross-referencing the run store, whose
  // run may belong to a newer broadcast by now (#10930).
  const disarmedCount = useFleetFailureStore((s) => s.disarmedCount);
  const [now, setNow] = useState(() => Date.now());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const unconfirmed: string[] = [];
  let nextDeadline: number | null = null;
  if (payload !== null) {
    for (const id of failedIds) {
      const deadline = crossHostSafeRetryDeadline(id, payload);
      if (deadline === null) continue;
      if (deadline <= now) unconfirmed.push(id);
      else if (nextDeadline === null || deadline < nextDeadline) nextDeadline = deadline;
    }
  }

  // Re-render when the next retry window closes, so the banner stops offering a safe retry.
  useEffect(() => {
    if (nextDeadline === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextDeadline - Date.now()));
    return () => clearTimeout(timer);
  }, [nextDeadline]);

  if (failedIds.size === 0) return null;

  const retryable = failedIds.size - unconfirmed.length;
  const hostNames = [
    ...new Set(unconfirmed.map((id) => getCrossHostTarget(id)?.hostName ?? "another host")),
  ];
  const where = hostNames.length === 1 ? hostNames[0]! : plural(hostNames.length, "host", "hosts");
  const agents = plural(unconfirmed.length, "agent", "agents");

  const disarmedSuffix =
    disarmedCount > 0
      ? ` ${disarmedCount} unreachable ${disarmedCount === 1 ? "terminal was" : "terminals were"} disarmed.`
      : "";
  const rejected =
    retryable > 0 ? `${plural(retryable, "terminal", "terminals")} rejected the write.` : "";
  const unknown =
    unconfirmed.length > 0
      ? `Couldn't confirm whether ${agents} on ${where} received the prompt. Sending it again may deliver it twice.`
      : "";
  const description =
    payload === null
      ? `${plural(failedIds.size, "terminal", "terminals")} rejected a keystroke. Single keystrokes can't be replayed.${disarmedSuffix}`
      : [rejected, unknown].filter(Boolean).join(" ") + disarmedSuffix;

  let action: BannerAction | undefined;
  if (payload !== null && retryable > 0) {
    action = { id: "retry", label: "Retry", variant: "primary", onClick: retryFailures };
  } else if (payload !== null) {
    action = {
      id: "send-again",
      label: "Send again…",
      variant: "primary",
      onClick: () => setConfirmOpen(true),
    };
  }

  return (
    <>
      <InlineStatusBanner
        severity="error"
        title={
          retryable === 0 && unconfirmed.length > 0 ? "Broadcast unconfirmed" : "Broadcast failed"
        }
        description={description}
        action={action}
        trailingSlot={
          // Retry leads for the safe targets; the unconfirmed ones stay reachable beside it.
          payload !== null && retryable > 0 && unconfirmed.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
              Send again…
            </Button>
          ) : undefined
        }
        role="alert"
        onClose={() => useFleetFailureStore.getState().clear()}
      />
      <ConfirmDialog
        isOpen={confirmOpen && unconfirmed.length > 0}
        onClose={() => setConfirmOpen(false)}
        title={`Send the prompt to ${where} again?`}
        description={`${where} never confirmed the first send, and it's too late to check. If it arrived, ${unconfirmed.length === 1 ? "the agent gets" : `the ${agents} get`} the prompt twice.`}
        confirmLabel="Send prompt"
        variant="default"
        onConfirm={() => {
          setConfirmOpen(false);
          confirmCrossHostResend(unconfirmed);
          retryFailures();
        }}
      />
    </>
  );
}
