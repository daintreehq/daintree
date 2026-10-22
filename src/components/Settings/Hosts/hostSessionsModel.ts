import type {
  HostAttachedShell,
  HostLinkEndCause,
  HostLinkEvent,
  HostLinkRefusalReason,
  HostLinkResumeRefusal,
} from "@shared/types/ipc/hostMetrics";
import type { HostDriverObservation } from "@shared/types/remoteHosts";
import { formatHostTime } from "@/components/Hosts/hostTime";
import { pluralize } from "@/lib/pluralize";

/** This Shell's own launch, as the host knows it. */
export interface ShellSelf {
  clientId: string;
  clientName: string;
}

export interface SessionRowText {
  label: string;
  description: string;
}

const RESUME_REFUSAL: Record<HostLinkResumeRefusal, string> = {
  "session-unknown": "the host didn't know it",
  "secret-mismatch": "its resume secret didn't match",
  "client-mismatch": "it belonged to another launch",
};

const END_CAUSE: Record<HostLinkEndCause, string> = {
  goodbye: "closed by the Shell",
  "protocol-error": "protocol error",
  "grace-expired": "not resumed in time",
  "session-cap": "too many sessions",
  "session-replaced": "replaced by a newer session from the same install",
  "host-shutdown": "the host shut down",
};

const REFUSAL: Record<HostLinkRefusalReason, string> = {
  unauthorized: "not authorized",
  "version-mismatch": "different build",
  protocol: "protocol error",
  busy: "too many sessions",
  "shutting-down": "the host was shutting down",
};

/**
 * A Shell launch by its machine name. This launch says so, and another
 * launch under the same name (most often an earlier run of this app) is told
 * apart from it rather than reading as the same thing.
 */
export function shellName(clientId: string, clientName: string, self: ShellSelf | null): string {
  if (self?.clientId === clientId) return `${clientName} (this launch)`;
  if (self?.clientName === clientName) return `${clientName} (another launch)`;
  return clientName;
}

/** One link event, in the words of what the host saw. `now` is the host's clock. */
export function describeLinkEvent(
  event: HostLinkEvent,
  self: ShellSelf | null,
  now: number
): SessionRowText {
  const who = shellName(event.clientId, event.clientName, self);
  const at = formatHostTime(event.at, now);
  switch (event.kind) {
    case "session-started":
      return {
        label: event.previousNotResumed
          ? `New session; the previous one wasn't resumed: ${RESUME_REFUSAL[event.previousNotResumed]}`
          : "Session started",
        description: `${who} · ${at}`,
      };
    case "session-resumed":
      return {
        label: event.overLiveLink ? "Session resumed over a new link" : "Session resumed",
        description: `${who} · ${at}`,
      };
    case "link-dropped":
      return {
        label: `Link dropped: ${event.reason}`,
        description: `${who} · ${at} · session held for it to resume`,
      };
    case "session-ended":
      return {
        label: `Session ended: ${END_CAUSE[event.cause]}${event.reason ? ` (${event.reason})` : ""}`,
        description: `${who} · ${at}`,
      };
    case "refused": {
      const times = event.count > 1 ? ` (${pluralize(event.count, "time")})` : "";
      const last = event.count > 1 ? `, last at ${formatHostTime(event.lastAt, now)}` : "";
      return {
        label: `Refused: ${REFUSAL[event.reason]}${times}`,
        description: `${who} · ${at}${last}${event.detail ? ` · ${event.detail}` : ""}`,
      };
    }
  }
}

/** Who holds a project, and whether that holder is there or away inside its reservation. */
export function describeDriverRow(
  driver: HostDriverObservation,
  hostName: string,
  self: ShellSelf | null,
  now: number
): SessionRowText {
  const { holder } = driver;
  const who = holder.isHostLocal
    ? `${hostName}'s own screen`
    : shellName(holder.clientId, holder.clientName, self);
  const state =
    driver.state === "live"
      ? `in control since ${formatHostTime(holder.acquiredAt, now)}`
      : driver.awayUntil === null
        ? "away"
        : `away · held for it until ${formatHostTime(driver.awayUntil, now)}`;
  return { label: driver.projectName ?? "Unknown project", description: `${who} · ${state}` };
}

/** An attached launch, when it connected, and what it drives. */
export function describeAttachedShell(
  shell: HostAttachedShell,
  drivers: readonly HostDriverObservation[],
  self: ShellSelf | null,
  now: number
): SessionRowText {
  const names = shell.drivingProjectIds.map(
    (projectId) =>
      drivers.find((driver) => driver.projectId === projectId)?.projectName ?? "Unknown project"
  );
  const driving =
    names.length === 0
      ? "not driving a project"
      : names.length <= 3
        ? `driving ${names.join(", ")}`
        : `driving ${pluralize(names.length, "project")}`;
  return {
    label: shellName(shell.clientId, shell.clientName, self),
    description: `Connected since ${formatHostTime(shell.connectedAt, now)} · ${driving}`,
  };
}
