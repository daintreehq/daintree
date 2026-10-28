import { useCallback } from "react";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { isHandBackUnseen } from "@shared/utils/runHandBack";
import type { AgentSnoozeDurationOption } from "@shared/utils/agentSnoozeDurations";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

export type HandBackMenuState = "none" | "unseen" | "seen";

/**
 * What the fleet snapshot says about this panel's run, read only while the
 * menu is live: a closed menu must not re-render on every snapshot push.
 */
export function useFleetRunMenuState(terminalId: string, isMenuLive: boolean) {
  // Snooze needs more than fleet eligibility: that only means "live PTY in a
  // grid location", while `snoozeRun` rejects any id the fleet snapshot can't
  // see. A plain shell terminal is eligible and never on the snapshot, so
  // without this the menu would offer a Snooze that always failed — and the
  // rejection is fire-and-forget, so the user would see nothing at all. Gate on
  // the same set the handler validates against.
  const isKnownRun = useFleetSnapshotStore(
    (s) => isMenuLive && (s.snapshot?.runs.some((run) => run.runId === terminalId) ?? false)
  );
  // Main strips expired snoozes before a row ships, so presence on the snapshot
  // IS "currently snoozed" — the menu needs no clock and never has to decide
  // whether a wake time has passed.
  const isSnoozed = useFleetSnapshotStore(
    (s) =>
      isMenuLive &&
      (s.snapshot?.runs.some((run) => run.runId === terminalId && run.snooze !== undefined) ??
        false)
  );
  // Whether main watched this run hand work back, and whether it has been seen
  // since: only a run with a hand-back has anything to mark read or unread.
  const handBackState = useFleetSnapshotStore((s): HandBackMenuState => {
    if (!isMenuLive) return "none";
    const handBack = s.snapshot?.runs.find((run) => run.runId === terminalId)?.handBack;
    if (handBack === undefined) return "none";
    return isHandBackUnseen(handBack) ? "unseen" : "seen";
  });

  const handleSnooze = useCallback(
    (option: AgentSnoozeDurationOption) => {
      safeFireAndForget(window.electron.fleet.snoozeRun(terminalId, option), {
        context: "TerminalContextMenu snoozeRun",
      });
    },
    [terminalId]
  );

  const handleToggleHandBackRead = useCallback(() => {
    const markRead = handBackState === "unseen";
    safeFireAndForget(
      markRead
        ? window.electron.fleet.markRunRead(terminalId)
        : window.electron.fleet.markRunUnread(terminalId),
      {
        context: markRead ? "TerminalContextMenu markRunRead" : "TerminalContextMenu markRunUnread",
      }
    );
  }, [handBackState, terminalId]);

  // Presence on the snapshot IS "parked", exactly as for snoozes.
  const isParked = useFleetSnapshotStore(
    (s) =>
      isMenuLive &&
      (s.snapshot?.runs.some((run) => run.runId === terminalId && run.park !== undefined) ?? false)
  );

  // Main rejects a park over retained (degraded) data; Unpark needs no
  // healthy snapshot, so only Park… waits for one.
  const isFleetDegraded = useFleetSnapshotStore(
    (s) => isMenuLive && (s.snapshot?.degraded ?? false)
  );
  const canPark = isKnownRun && !isFleetDegraded;

  const handleUnpark = useCallback(() => {
    safeFireAndForget(window.electron.fleet.unparkRun(terminalId), {
      context: "TerminalContextMenu unparkRun",
    });
  }, [terminalId]);

  const handleUnsnooze = useCallback(() => {
    safeFireAndForget(window.electron.fleet.unsnoozeRun(terminalId), {
      context: "TerminalContextMenu unsnoozeRun",
    });
  }, [terminalId]);

  return {
    isKnownRun,
    isSnoozed,
    handBackState,
    isParked,
    canPark,
    handleSnooze,
    handleToggleHandBackRead,
    handleUnpark,
    handleUnsnooze,
  };
}
