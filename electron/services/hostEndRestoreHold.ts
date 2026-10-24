import { store, type StoreSchema } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import type { PendingCrash } from "../../shared/types/ipc/crashRecovery.js";
import type { PanelHostEnd, PanelRestoreRecovery } from "../../shared/types/panel.js";
import type { TerminalSnapshot } from "../../shared/types/project.js";

export type HostEndRestoreHold = NonNullable<StoreSchema["hostEndRestoreHold"]>;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The unclean end a crash record shows (#14382): the watchdog's kill flag, or a
 * heartbeat that stopped with no reboot behind it. A crash the app recorded
 * itself, a power loss and a lost suspend are not this: none of them says the
 * agents' own load is what took the app down.
 */
export function readHostEnd(pending: PendingCrash | null): PanelHostEnd | undefined {
  const entry = pending?.entry;
  if (!entry) return undefined;
  const cause: PanelHostEnd["cause"] | undefined =
    entry.cause === "watchdog-deadlock"
      ? "watchdog-deadlock"
      : entry.crashCause === "external-kill"
        ? "external-kill"
        : undefined;
  if (cause === undefined) return undefined;
  const at =
    cause === "watchdog-deadlock" && typeof entry.watchdogKilledAt === "number"
      ? entry.watchdogKilledAt
      : entry.timestamp;
  const missedBeats = cause === "watchdog-deadlock" ? entry.watchdogMissedBeats : undefined;
  return {
    cause,
    at,
    ...(typeof missedBeats === "number" && missedBeats > 0 && { missedBeats }),
  };
}

/**
 * Remember an unclean end until every workspace's saved panes have heard of
 * it. The record outlives this session on purpose: a project nobody opens
 * until after a clean quit, or a reboot, still had its agents cut short by it.
 * A newer end replaces an older one.
 */
export function recordHostEnd(pending: PendingCrash | null): void {
  const hostEnd = readHostEnd(pending);
  if (!hostEnd) return;
  try {
    store.set("hostEndRestoreHold", { ...hostEnd, appliedWorkspaceIds: [] });
    console.log("[HostEndHold] Agents running when the app ended will wait to be resumed", {
      cause: hostEnd.cause,
    });
  } catch (error) {
    console.warn("[HostEndHold] Failed to record the unclean end:", error);
  }
}

function readLedger(): HostEndRestoreHold | undefined {
  try {
    const value: unknown = store.get("hostEndRestoreHold");
    if (!isPlainObject(value)) return undefined;
    if (value.cause !== "watchdog-deadlock" && value.cause !== "external-kill") return undefined;
    if (typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined;
    const applied = Array.isArray(value.appliedWorkspaceIds)
      ? value.appliedWorkspaceIds.filter((id): id is string => typeof id === "string")
      : [];
    return {
      cause: value.cause,
      at: value.at,
      ...(typeof value.missedBeats === "number" && { missedBeats: value.missedBeats }),
      appliedWorkspaceIds: applied,
    };
  } catch {
    return undefined;
  }
}

function heldSessionId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("-") &&
    !CONTROL_CHARS.test(value)
    ? value
    : undefined;
}

/**
 * Whether a saved pane is an agent the unclean end cut short. A pane already
 * held keeps its own hold, as does one its plugin asked to hold; a pane whose
 * agent was last seen exiting had already ended on its own.
 */
function wasCutShort(terminal: TerminalSnapshot): boolean {
  if (!isPlainObject(terminal)) return false;
  if (typeof terminal.launchAgentId !== "string" || terminal.launchAgentId === "") return false;
  const kind: unknown = terminal.kind;
  if (kind !== undefined && kind !== "terminal" && kind !== "agent") return false;
  if (terminal.location === "trash") return false;
  if (isPlainObject(terminal.restoreRecovery)) return false;
  if (terminal.holdOnRestart === true) return false;
  const observed: unknown = terminal.lastAgentObservation;
  if (isPlainObject(observed) && observed.agentState === "exited") return false;
  return true;
}

/** Hold every agent pane in `terminals` the unclean end cut short. Pure. */
export function holdTerminalsEndedByHost(
  terminals: readonly TerminalSnapshot[],
  hostEnd: PanelHostEnd
): { terminals: TerminalSnapshot[]; held: number } {
  let held = 0;
  const next = terminals.map((terminal) => {
    if (!wasCutShort(terminal)) return terminal;
    held++;
    const sessionId = heldSessionId(terminal.agentSessionId);
    const restoreRecovery: PanelRestoreRecovery = {
      reason: "host-ended-uncleanly",
      ...(sessionId !== undefined && { sessionId }),
      hostEnd,
    };
    return { ...terminal, restoreRecovery };
  });
  return { terminals: held > 0 ? next : [...terminals], held };
}

function hostEndOf(ledger: HostEndRestoreHold): PanelHostEnd {
  return {
    cause: ledger.cause,
    at: ledger.at,
    ...(ledger.missedBeats !== undefined && { missedBeats: ledger.missedBeats }),
  };
}

/**
 * `terminals` with the recorded unclean end applied, for a crash restore that
 * puts the pre-crash panes back on the global record. Unchanged when nothing
 * is recorded.
 */
export function holdTerminalsForRecordedHostEnd<T>(terminals: T[]): T[] {
  const ledger = readLedger();
  if (!ledger) return terminals;
  return holdTerminalsEndedByHost(terminals as TerminalSnapshot[], hostEndOf(ledger))
    .terminals as T[];
}

/**
 * Hold the saved agent panes of `workspaceId` that an unclean end cut short,
 * once per workspace per end. Awaited by hydrate before it reads the
 * workspace's state, so every restore that reads it — this machine's own view
 * or a Shell relaunching onto this host — sees the hold. Resuming a pane is
 * what clears it, as for every other hold.
 */
export async function applyHostEndHold(workspaceId: string | null): Promise<number> {
  if (!workspaceId) return 0;
  const ledger = readLedger();
  if (!ledger || ledger.appliedWorkspaceIds.includes(workspaceId)) return 0;
  const hostEnd = hostEndOf(ledger);
  let held = 0;
  try {
    await projectStore.enqueueProjectStateUpdate(workspaceId, (existing) => {
      if (!existing || !Array.isArray(existing.terminals)) return null;
      const result = holdTerminalsEndedByHost(existing.terminals, hostEnd);
      held = result.held;
      return result.held > 0 ? { ...existing, terminals: result.terminals } : null;
    });
  } catch (error) {
    // Left unapplied, so the next hydrate tries again rather than resuming.
    console.warn("[HostEndHold] Failed to hold the workspace's agents:", error);
    return 0;
  }
  // Re-read: a newer end may have replaced the record while the update ran.
  const latest = readLedger();
  if (latest && latest.at === ledger.at && !latest.appliedWorkspaceIds.includes(workspaceId)) {
    try {
      store.set("hostEndRestoreHold", {
        ...latest,
        appliedWorkspaceIds: [...latest.appliedWorkspaceIds, workspaceId],
      });
    } catch (error) {
      console.warn("[HostEndHold] Failed to record the held workspace:", error);
    }
  }
  if (held > 0) {
    console.log("[HostEndHold] Held agents the unclean end cut short", {
      workspaceId,
      count: held,
      cause: hostEnd.cause,
    });
  }
  return held;
}
