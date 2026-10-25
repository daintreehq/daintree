import {
  HOST_LIST_CLIS_MAX,
  type HostListAgentClis,
  type HostListBuild,
  type HostListLink,
} from "../../../shared/types/hostControl.js";
import type {
  HandshakeMismatch,
  HostConnectionState,
  HostHandshakeInfo,
  HostMetricsSummary,
} from "../../../shared/types/remoteHosts.js";
import { HOST_LOAD_STALE_MS } from "./hostLoad.js";

/** Longest build string a handshake carries on the wire. */
const BUILD_FIELD_MAX = 64;
/**
 * Agent ids are short registry keys; a host may send up to 256 characters,
 * which across 32 CLIs and a few hosts would outgrow the MCP result cap.
 */
const CLI_ID_MAX = 64;

const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

const stampOrNull = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function mismatchOf(mismatch: HandshakeMismatch): NonNullable<HostListLink["mismatch"]> {
  return {
    kind: mismatch.kind,
    local: clip(String(mismatch.local), BUILD_FIELD_MAX),
    remote: clip(String(mismatch.remote), BUILD_FIELD_MAX),
  };
}

/**
 * The link's own flags, copied field by field: an unreachable link's `detail`
 * is raw transport text (ssh stderr, paths) and never leaves this machine.
 */
export function projectHostLink(
  state: HostConnectionState,
  disconnectedByPerson: boolean
): HostListLink {
  const link: HostListLink = {
    status: state.status,
    attempt: null,
    restarting: false,
    hostModeOff: false,
    stoppedRetrying: null,
    disconnectedByPerson: state.status === "disconnected" && disconnectedByPerson,
    quietSince: null,
    mismatch: null,
  };
  switch (state.status) {
    case "connecting":
      return { ...link, attempt: state.attempt, restarting: state.restarting === true };
    case "connected":
      return {
        ...link,
        quietSince: stampOrNull(state.quietSince),
        mismatch: state.buildMismatch ? mismatchOf(state.buildMismatch) : null,
      };
    case "unreachable":
      return {
        ...link,
        restarting: state.restarting === true,
        hostModeOff: state.hostModeOff === true,
        stoppedRetrying: state.stoppedRetrying === true,
      };
    case "version-mismatch":
      return { ...link, mismatch: mismatchOf(state.mismatch) };
    default:
      return link;
  }
}

function handshakeOf(info: HostHandshakeInfo): NonNullable<HostListBuild["handshake"]> {
  return {
    version: clip(info.version, BUILD_FIELD_MAX),
    commit: clip(info.commit, BUILD_FIELD_MAX),
    protocolVersion: info.protocolVersion,
    platform: info.platform,
    arch: info.arch,
  };
}

/** The build the link is talking to, else the one it refused, else the last one it saw. */
export function projectHostBuild(
  state: HostConnectionState,
  lastHandshake: HostHandshakeInfo | null
): HostListBuild {
  if (state.status === "connected") {
    return { source: "connected", handshake: handshakeOf(state.handshake) };
  }
  if (state.status === "version-mismatch") {
    return { source: "rejected", handshake: handshakeOf(state.remote) };
  }
  return lastHandshake
    ? { source: "last-seen", handshake: handshakeOf(lastHandshake) }
    : { source: "unknown", handshake: null };
}

/**
 * The CLIs a host's own detection found, from its last summary: `observed`
 * only while the link is up and the sample is fresh, by the same rule as
 * load. An empty list is unknown, since a host that hasn't run detection yet
 * reports none. Presence only: nothing here says a CLI is signed in.
 */
export function projectHostAgentClis(
  summary: HostMetricsSummary | null,
  live: boolean,
  now: number
): HostListAgentClis {
  const sampledAt = summary ? stampOrNull(summary.sampledAt) : null;
  const all = summary?.agentClis ?? [];
  if (all.length === 0) return { coverage: "unknown", sampledAt, installed: [], omitted: 0 };
  const fresh = sampledAt !== null && Math.abs(now - sampledAt) <= HOST_LOAD_STALE_MS;
  return {
    coverage: live && fresh ? "observed" : "stale",
    sampledAt,
    installed: all.slice(0, HOST_LIST_CLIS_MAX).map(({ agentId, version }) => ({
      agentId: clip(agentId, CLI_ID_MAX),
      version: version === null ? null : clip(version, BUILD_FIELD_MAX),
    })),
    omitted: Math.max(0, all.length - HOST_LIST_CLIS_MAX),
  };
}
