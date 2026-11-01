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

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function protocolRange({ protocolMin, protocolMax }: DecisionsRelayVersions): string {
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

/**
 * The relay's versions beside the ones this Daintree expects, and when they
 * diverge, what would bring them together. Daintree never updates the relay
 * itself, so the prompt names what the person would do.
 */
export function describeCompatibility(compatibility: DecisionsRelayCompatibility): {
  label: string;
  detail: string;
} {
  const versions = `The relay runs ${versionsOf(compatibility.relay)}. Daintree expects ${versionsOf(compatibility.daintree)}.`;
  if (!compatibility.diverges) {
    return {
      label: "Relay and Daintree versions match",
      detail: `Both on ${versionsOf(compatibility.relay)}`,
    };
  }
  const newer = newerSide(compatibility);
  switch (newer) {
    case "relay":
      return {
        label: "The relay is newer than Daintree",
        detail: `${versions} Update Daintree to match it.`,
      };
    case "daintree":
      return {
        label: "The relay needs an update",
        detail: `${versions} Deploy the new release to it the same way it was deployed; Daintree never updates it for you.`,
      };
    default:
      return {
        label: "Relay and Daintree versions differ",
        detail: `${versions} Update Daintree or the relay so they match; Daintree never updates the relay for you.`,
      };
  }
}
