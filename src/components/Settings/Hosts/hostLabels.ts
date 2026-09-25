import type {
  HostArch,
  HostConnectionState,
  HostDescriptor,
  HostPlatform,
} from "@shared/types/remoteHosts";
import type { HostInstallInfo, HostInstallPlan } from "@shared/types/ipc/remoteHosts";

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
    case "connected":
      return state.rttMs === null ? "Connected" : `Connected · ${Math.round(state.rttMs)} ms`;
    case "unreachable":
      return `Unreachable · ${formatSeen(state.lastSeenAt)}`;
    case "version-mismatch":
      return `Runs Daintree ${state.remote.version} (${shortCommit(state.remote.commit)})`;
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
      return `The host downloads ${what} for Daintree ${plan.version} from the ${plan.channel} release feed`;
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
