import type { PendingCrash } from "../../shared/types/ipc/crashRecovery.js";
import type { PanelHostEnd, PanelRestoreRecovery } from "../../shared/types/panel.js";
import type { TerminalSnapshot } from "../../shared/types/project.js";
import { inferKind } from "../../shared/utils/inferPanelKind.js";
import { resolveRespawnAgentId } from "../../shared/utils/savedAgentIdentity.js";

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

function heldSessionId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("-") &&
    !CONTROL_CHARS.test(value)
    ? value
    : undefined;
}

/**
 * Whether a saved pane is an agent the unclean end cut short, identified the
 * way restore identifies the agent it respawns. A pane already held keeps its
 * own hold, as does one its plugin asked to hold; a pane whose agent was last
 * seen exiting had already ended on its own.
 */
function wasCutShort(terminal: TerminalSnapshot, workspaceId: string | undefined): boolean {
  if (!isPlainObject(terminal)) return false;
  if (terminal.location === "trash") return false;
  const kind = inferKind(terminal, workspaceId);
  if (kind !== "terminal") return false;
  if (resolveRespawnAgentId(terminal, kind) === undefined) return false;
  if (isPlainObject(terminal.restoreRecovery)) return false;
  if (terminal.holdOnRestart === true) return false;
  const observed: unknown = terminal.lastAgentObservation;
  const lastState = isPlainObject(observed) ? observed.agentState : terminal.agentState;
  return lastState !== "exited";
}

/** Hold every agent pane in `terminals` the unclean end cut short. Pure. */
export function holdTerminalsEndedByHost<T>(
  terminals: readonly T[],
  hostEnd: PanelHostEnd,
  workspaceId?: string
): { terminals: T[]; held: number } {
  let held = 0;
  const next = terminals.map((terminal) => {
    const snapshot = terminal as TerminalSnapshot;
    if (!wasCutShort(snapshot, workspaceId)) return terminal;
    held++;
    const sessionId = heldSessionId(snapshot.agentSessionId);
    const restoreRecovery: PanelRestoreRecovery = {
      reason: "host-ended-uncleanly",
      ...(sessionId !== undefined && { sessionId }),
      hostEnd,
    };
    return { ...snapshot, restoreRecovery } as T;
  });
  return { terminals: next, held };
}
