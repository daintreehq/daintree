import type {
  HandshakeMismatch,
  HostArch,
  HostConnectionState,
  HostDescriptor,
  HostPlatform,
} from "@shared/types/remoteHosts";
import type {
  HostInstallInfo,
  HostInstallPlan,
  HostProbeResult,
  HostRestartImpact,
} from "@shared/types/ipc/remoteHosts";
import { pluralize } from "@/lib/pluralize";

export function platformLabel(platform: HostPlatform | null, arch: HostArch | null): string {
  if (!platform) return "Platform not seen yet";
  const os = platform === "darwin" ? "macOS" : "Linux";
  if (!arch) return os;
  const cpu = platform === "darwin" && arch === "arm64" ? "Apple silicon" : arch;
  return `${os} · ${cpu}`;
}

export function shortCommit(commit: string | null | undefined): string | null {
  return commit ? commit.slice(0, 7) : null;
}

/** What differs about a host's build, as the handshake reported it: "different build (0.43.0)". */
export function describeBuildMismatch(mismatch: HandshakeMismatch): string {
  switch (mismatch.kind) {
    case "protocol":
      return `different link protocol (${mismatch.remote})`;
    case "version":
      return `different build (${mismatch.remote})`;
    case "commit":
      return `different build (${shortCommit(mismatch.remote)})`;
  }
}

/** How a host's build compares with this machine's, for its Build row: "Differs from this machine (0.43.0)". */
export function describeBuildDifference(mismatch: HandshakeMismatch): string {
  switch (mismatch.kind) {
    case "protocol":
      return `Uses link protocol ${mismatch.remote}; this machine uses ${mismatch.local}`;
    case "version":
      return `Differs from this machine (${mismatch.local})`;
    case "commit":
      return `Differs from this machine (${shortCommit(mismatch.local)})`;
  }
}

export function buildLabel(descriptor: HostDescriptor): string {
  const seen = descriptor.lastHandshake;
  if (!seen) return "Build not seen yet";
  return `Daintree ${seen.version} (${shortCommit(seen.commit)})`;
}

export function installLabel(install: HostInstallInfo | null): string {
  if (!install) return "Daintree isn't installed";
  const version = install.version ? `Daintree ${install.version}` : "Daintree (version unknown)";
  const commit = shortCommit(install.commit);
  return commit ? `${version} (${commit})` : version;
}

function formatSeen(at: number | null): string {
  if (at === null) return "never seen";
  return `last seen ${new Date(at).toLocaleString()}`;
}

/** What the link last reported: observations only, never a guessed cause. */
export function connectionLabel(state: HostConnectionState): string {
  switch (state.status) {
    case "local":
      return "This machine";
    case "disconnected":
      return "Not connected";
    case "connecting":
      return state.attempt > 1 ? `Connecting (attempt ${state.attempt})` : "Connecting";
    case "connected": {
      if (state.quietSince !== undefined) {
        return `Connected · no reply since ${new Date(state.quietSince).toLocaleTimeString()}`;
      }
      // A build that differs but connected is the Build row's to say, not the link's.
      return state.rttMs === null ? "Connected" : `Connected · ${Math.round(state.rttMs)} ms`;
    }
    case "unreachable":
      if (state.hostModeOff) return "Daintree isn't running in Host mode there";
      // What was seen, when there is something: ssh's own words for why it couldn't reach it.
      return [
        "Unreachable",
        formatSeen(state.lastSeenAt),
        ...(state.stoppedRetrying ? ["not retrying until you connect"] : []),
        ...(state.detail ? [state.detail] : []),
      ].join(" · ");
    case "version-mismatch":
      // Exact builds are the Build row's; here, what it means for connecting.
      return "Can't connect · needs a compatible build";
    case "driven-elsewhere":
      return `Driven from ${state.driver.clientName}`;
  }
}

export function deliveryLabel(plan: HostInstallPlan): string {
  const what =
    plan.packaging === "app-bundle"
      ? "the macOS app"
      : plan.packaging === "deb"
        ? "the .deb package"
        : "the AppImage";
  switch (plan.delivery) {
    case "push-bundle":
      return `Copies this machine's own build (${what}) to the host`;
    case "host-fetch":
      return `The host downloads ${what} for Daintree ${plan.version} from the ${plan.channel} release feed; if it can't reach the feed, this machine downloads it and copies it over`;
    case "client-download-push":
      return `Downloads ${what} for Daintree ${plan.version} here and copies it to the host`;
    default:
      return "";
  }
}

/** A readable default name for a machine from what the user typed or discovery found. */
export function defaultHostName(sshTarget: string): string {
  const host = sshTarget.slice(sshTarget.lastIndexOf("@") + 1);
  return host.split(".")[0] || host;
}

/**
 * `user@studio.local` for `user@studio` when ssh couldn't resolve that bare
 * name itself: on a LAN a machine usually answers only by its Bonjour name.
 * Null when the name already has a domain, or ssh failed on some other name
 * (an ~/.ssh/config alias's HostName, a jump host), where `.local` would
 * bypass that configuration.
 */
export function localNameSuggestion(sshTarget: string, sshError: string | null): string | null {
  const unresolved = /Could not resolve hostname ([^\s:]+)/i.exec(sshError ?? "")?.[1];
  if (!unresolved) return null;
  const at = sshTarget.lastIndexOf("@");
  const host = sshTarget.slice(at + 1);
  if (!host || host.includes(".") || host.includes(":") || host.startsWith("[")) return null;
  if (unresolved.toLowerCase() !== host.toLowerCase()) return null;
  return `${sshTarget.slice(0, at + 1)}${host}.local`;
}

/**
 * Host mode is on for good there: listening, saved as on and set to start at
 * login, as the host's own Daintree recorded it and the probe saw it.
 */
export function hostModeSwitchedOn(probe: HostProbeResult | null): boolean {
  const state = probe?.hostModeState;
  return (
    probe?.hostModeListening === true &&
    !!state &&
    state.enabled &&
    state.startAtLogin &&
    state.startAtLoginInstalled === true &&
    probe.advice.startAtLoginInstalled === true
  );
}

/**
 * What restarting a host ends, a line per item, in the host's own counts.
 * Agent states are what was observed, never a claim that the rest is idle.
 */
export function restartImpactLines(impact: HostRestartImpact): string[] {
  const detail = impact.detail;
  if (detail) {
    const lines = detail.projects.map((project) => {
      const agents = [
        project.working > 0 ? `${project.working} working` : null,
        project.waiting > 0 ? `${project.waiting} waiting` : null,
      ].filter((part) => part !== null);
      const name = project.projectName ?? "Outside any project";
      const terminals = pluralize(project.terminals, "terminal");
      return agents.length > 0
        ? `${name}: ${terminals} (agents ${agents.join(", ")})`
        : `${name}: ${terminals}`;
    });
    if (!detail.complete) lines.push("Possibly more terminals: the host couldn't list them all");
    if (detail.operations > 0) {
      lines.push(`${pluralize(detail.operations, "operation")} still running`);
    }
    if (detail.otherShells.length > 0) {
      lines.push(`Sessions from ${detail.otherShells.join(", ")}`);
    }
    return lines;
  }
  const agents = impact.agents;
  if (!agents) return ["Every terminal there: the host couldn't say what is running"];
  const waiting =
    agents.waiting === null
      ? "whether any agents are waiting can't be seen"
      : pluralize(agents.waiting, "agent") + " waiting";
  return [
    `${pluralize(agents.working, "agent")} working, ${waiting}`,
    "Every other terminal there too: plain shells and dev servers aren't reported by this host",
  ];
}

/** Terminals the restart ends, when the host counted them; null when it couldn't. */
export function restartTerminalCount(impact: HostRestartImpact): number | null {
  if (!impact.detail) return null;
  return impact.detail.projects.reduce((sum, project) => sum + project.terminals, 0);
}

/** Whether waiting for idle can be watched: the host reports both working and waiting agents. */
export function canWaitForIdle(impact: HostRestartImpact): boolean {
  return impact.detail !== null || (impact.agents !== null && impact.agents.waiting !== null);
}
