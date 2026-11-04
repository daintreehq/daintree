import * as semver from "semver";
import type { StatusSeverity } from "@/lib/statusSeverity";
import type {
  DecisionsRelayCheck,
  DecisionsRelayCompatibility,
  DecisionsRelayEndpoint,
  DecisionsRelayUnreachableReason,
  DecisionsRelayVersions,
} from "@shared/types/decisions";

export interface RelayObservation {
  severity: StatusSeverity;
  label: string;
  detail: string;
}

const PATH: Record<DecisionsRelayEndpoint, string> = {
  health: "/health",
  info: "/api/v1/info",
};

const UNREACHABLE: Record<DecisionsRelayUnreachableReason, string> = {
  timeout: "It didn't answer in time",
  dns: "Its name doesn't resolve, so check the address for a typo",
  refused: "It refused the connection",
  certificate: "Its certificate wasn't trusted",
  network: "The connection failed before it answered",
};

/** Why a request got no answer, in words. */
export function describeUnreachable(reason: DecisionsRelayUnreachableReason): string {
  return UNREACHABLE[reason];
}

/** Why a typed address wasn't checked, for the field's own error. */
export function describeInvalidUrl(
  reason: Extract<DecisionsRelayCheck, { result: "invalid-url" }>["reason"]
): string {
  switch (reason) {
    case "not-https":
      return "Use the relay's https:// address";
    case "credentials":
      return "Remove the user name and password; a relay address never carries them";
    default:
      return "Enter a web address, such as https://decisions.example.workers.dev";
  }
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function protocolRange({
  protocolMin,
  protocolMax,
}: Pick<DecisionsRelayVersions, "protocolMin" | "protocolMax">): string {
  return protocolMin === protocolMax
    ? `protocol ${protocolMin}`
    : `protocols ${protocolMin}–${protocolMax}`;
}

/**
 * What a check saw, in words: the observation itself, never what it implies
 * about agents. Null for an address that was never sent, whose words belong
 * on the field.
 */
export function describeRelayCheck(check: DecisionsRelayCheck): RelayObservation | null {
  if (check.result === "invalid-url") return null;
  const host = hostOf(check.origin);
  switch (check.result) {
    case "unreachable":
      return {
        severity: "error",
        label: `Couldn't reach ${host}`,
        detail:
          check.endpoint === "health"
            ? UNREACHABLE[check.reason]
            : check.reason === "timeout"
              ? "/health answered, but /api/v1/info didn't answer in time"
              : "/health answered, but the connection failed reading /api/v1/info",
      };
    case "http-error":
      return {
        severity: "warning",
        label: `${host} answered with an error`,
        detail: `${PATH[check.endpoint]} answered HTTP ${check.status}. Try again in a moment, or look at the Worker's logs in Cloudflare.`,
      };
    case "not-a-relay":
      return {
        severity: "error",
        label: `${host} isn't a Decisions relay`,
        detail:
          check.answered === "redirect"
            ? `${PATH[check.endpoint]} redirected somewhere else instead of answering`
            : check.answered === "status"
              ? `${PATH[check.endpoint]} answered HTTP ${check.status}`
              : check.endpoint === "health"
                ? "/health didn't answer the way a Decisions relay does"
                : "/api/v1/info didn't describe a Decisions relay",
      };
    case "incompatible":
      return {
        severity: "error",
        label: `${host} speaks a protocol Daintree doesn't`,
        detail: `The relay speaks ${protocolRange(check.compatibility.relay)}; Daintree speaks ${protocolRange(check.compatibility.daintree)}`,
      };
    case "claim-not-configured":
      return {
        severity: "warning",
        label: `${host} has no claim secret set`,
        detail:
          "Nobody has claimed it, and it can't be claimed until CLAIM_SECRET is set on the Worker in your Cloudflare account",
      };
    case "unclaimed":
      return {
        severity: "success",
        label: `${host} is ready to claim`,
        detail:
          "A Decisions relay nobody has claimed yet. Claiming it takes the claim secret set when it was deployed.",
      };
    case "claimed":
      return {
        severity: "info",
        label: `${host} is claimed`,
        detail: "A Decisions relay that already has an owner. A relay is claimed only once.",
      };
  }
}

/**
 * Which side is the newer release, when that can be told; null when it
 * can't. Release order first (a prerelease before its release), then the
 * protocol range's top.
 */
function newerSide(compatibility: DecisionsRelayCompatibility): "relay" | "daintree" | null {
  const relay = semver.valid(compatibility.relay.workerVersion);
  const daintree = semver.valid(compatibility.daintree.workerVersion);
  if (relay && daintree) {
    const order = semver.compare(relay, daintree);
    if (order > 0) return "relay";
    if (order < 0) return "daintree";
  }
  if (compatibility.relay.protocolMax > compatibility.daintree.protocolMax) return "relay";
  if (compatibility.relay.protocolMax < compatibility.daintree.protocolMax) return "daintree";
  return null;
}

function versionsOf(side: DecisionsRelayVersions): string {
  return `${side.workerVersion}, ${protocolRange(side)}`;
}

/** Whether the relay is the side that's behind, so updating it is what would bring them together. */
export function relayIsBehind(compatibility: DecisionsRelayCompatibility): boolean {
  return compatibility.diverges && newerSide(compatibility) === "daintree";
}

/** The protocol versions both sides speak; null when they share none. */
function sharedProtocols({
  relay,
  daintree,
}: DecisionsRelayCompatibility): Pick<
  DecisionsRelayVersions,
  "protocolMin" | "protocolMax"
> | null {
  const protocolMin = Math.max(relay.protocolMin, daintree.protocolMin);
  const protocolMax = Math.min(relay.protocolMax, daintree.protocolMax);
  return protocolMin <= protocolMax ? { protocolMin, protocolMax } : null;
}

/**
 * Whether the relay is behind and can't work with this Daintree until it's
 * updated. An older release that still shares a protocol keeps asking and
 * answering, so its update is offered, not put forward.
 */
export function relayNeedsUpdate(compatibility: DecisionsRelayCompatibility): boolean {
  return relayIsBehind(compatibility) && sharedProtocols(compatibility) === null;
}

/**
 * Where an update to the relay comes from, for the words that point at it:
 * `offered` is Update relay in this Settings (#16201); `host` is a remote
 * window's, whose relay belongs to the Host; `cli` is anywhere else, such as a
 * relay checked before it's connected here.
 */
export type RelayUpdateRoute = "offered" | "host" | "cli";

const UPDATE_THE_RELAY: Record<RelayUpdateRoute, string> = {
  offered:
    "Update relay finds a release that works with this Daintree and asks before changing anything.",
  host: "Update it from Daintree on the Host, where it's set up.",
  cli: "Update it with decisions update from the Decisions CLI.",
};

const NEWER_RELAY: Record<RelayUpdateRoute, string> = {
  offered:
    "Update relay looks for a newer release that works with this Daintree and asks before changing anything.",
  host: "Daintree on the Host, where it's set up, can update it.",
  cli: "decisions update from the Decisions CLI can update it.",
};

const OR_UPDATE_THE_RELAY: Record<RelayUpdateRoute, string> = {
  offered:
    "Update Daintree, or use Update relay to move the relay to a release that works with it.",
  host: "Update Daintree, or update the relay from Daintree on the Host.",
  cli: "Update Daintree, or update the relay with decisions update from the Decisions CLI.",
};

/**
 * The relay's versions beside the ones this Daintree expects, and when they
 * diverge, what would bring them together, pointing at where the relay's
 * update comes from. Versions that differ but share a protocol still ask and
 * answer, so they're information; only ranges that share none are a warning.
 */
export function describeCompatibility(
  compatibility: DecisionsRelayCompatibility,
  route: RelayUpdateRoute = "cli"
): {
  severity: StatusSeverity;
  label: string;
  detail: string;
} {
  const versions = `The relay runs ${versionsOf(compatibility.relay)}. Daintree expects ${versionsOf(compatibility.daintree)}.`;
  if (!compatibility.diverges) {
    return {
      severity: "info",
      label: "Relay and Daintree versions match",
      detail: `Both on ${versionsOf(compatibility.relay)}`,
    };
  }
  const shared = sharedProtocols(compatibility);
  const severity: StatusSeverity = shared === null ? "warning" : "info";
  const newer = newerSide(compatibility);
  switch (newer) {
    case "relay":
      return {
        severity,
        label: "The relay is newer than Daintree",
        detail: `${versions} Update Daintree to match it.`,
      };
    case "daintree":
      return shared === null
        ? {
            severity,
            label: "The relay needs an update",
            detail: `${versions} ${UPDATE_THE_RELAY[route]}`,
          }
        : {
            severity,
            label: "The relay is an older release",
            detail: `${versions} Both speak ${protocolRange(shared)}, so questions and answers work. ${NEWER_RELAY[route]}`,
          };
    default:
      return {
        severity,
        label: "Relay and Daintree versions differ",
        detail: `${versions} ${OR_UPDATE_THE_RELAY[route]}`,
      };
  }
}
