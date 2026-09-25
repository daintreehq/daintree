import type { HostArch, HostPlatform } from "../../../shared/types/remoteHosts.js";
import type {
  HostInstallPlan,
  HostProbeResult,
  LinuxPackagePreference,
} from "../../../shared/types/ipc/remoteHosts.js";

/**
 * Which build a host gets and how it gets there. A host always runs exactly
 * this client's version and commit (the handshake refuses anything else), so
 * the choice is only about delivery:
 *
 * - same platform and arch, and this client has a bundle it can copy: push it;
 * - otherwise the host fetches its artifact for the exact version from the
 *   release feed the updater uses, or, when it can't download, this client
 *   fetches it and copies it over.
 *
 * Linux prefers the deb (declared dependencies, no FUSE; needs sudo, so the
 * user runs one shown command); the AppImage is the no-root fallback.
 */

export const STABLE_FEED_URL = "https://updates.daintree.org/releases/";
export const NIGHTLY_FEED_URL = "https://updates.daintree.org/nightly/";

export type UpdateChannel = "stable" | "nightly";

/** What this client can hand over of itself. */
export type ClientBundle =
  | { kind: "app-bundle"; path: string }
  | { kind: "appimage"; path: string }
  /** Installed from a deb: the package file isn't kept, so there's nothing to copy. */
  | { kind: "none" };

export interface ClientBuild {
  platform: HostPlatform;
  arch: HostArch;
  version: string;
  commit: string;
  /** The update channel this client follows; the host follows it too. */
  channel: UpdateChannel;
  bundle: ClientBundle;
}

/**
 * The feed that carries this exact version: nightly builds are published only
 * to the nightly feed, releases only to the stable one. Because the host gets
 * this client's own build, it is on this client's channel by construction.
 */
export function feedUrlFor(version: string): string {
  return version.includes("-nightly") ? NIGHTLY_FEED_URL : STABLE_FEED_URL;
}

/** Artifact names as the release build writes them (see electron-builder.config.cjs). */
export function artifactNameFor(
  arch: HostArch,
  packaging: "app-bundle" | "deb" | "appimage",
  version: string
): string {
  if (packaging === "app-bundle") return `Daintree-${version}-${arch}-mac.zip`;
  if (packaging === "deb") return `daintree_${version}_${arch === "x64" ? "amd64" : "arm64"}.deb`;
  return `Daintree-${version}-${arch === "x64" ? "x86_64" : "arm64"}.AppImage`;
}

function linuxPackaging(
  probe: HostProbeResult,
  preference: LinuxPackagePreference | undefined
): "deb" | "appimage" {
  if (preference) return preference;
  // An AppImage install is replaced in place without root; otherwise the deb.
  return probe.install?.packaging === "appimage" ? "appimage" : "deb";
}

export function planInstall(params: {
  client: ClientBuild;
  probe: HostProbeResult;
  linuxPackage?: LinuxPackagePreference;
  /** Why the AppImage in use can't be told apart (see ParsedProbe.appImageConflict). */
  appImageConflict?: string | null;
}): HostInstallPlan {
  const { client, probe } = params;
  const base = {
    version: client.version,
    commit: client.commit,
    channel: client.channel,
  };
  const unsupported = (reason: string): HostInstallPlan => ({
    ...base,
    kind: "unsupported",
    delivery: null,
    packaging: null,
    artifactName: null,
    artifactUrl: null,
    restartsHost: false,
    userCommandNeeded: false,
    reason,
  });
  if (!probe.reachable) return unsupported("The host couldn't be reached over SSH.");
  if (!probe.platform || !probe.arch) {
    return unsupported("The host's platform or architecture isn't one Daintree ships for.");
  }
  if (probe.matchesClient === true) {
    return {
      ...base,
      kind: "up-to-date",
      delivery: null,
      packaging: probe.install?.packaging === "unknown" ? null : (probe.install?.packaging ?? null),
      artifactName: null,
      artifactUrl: null,
      restartsHost: false,
      userCommandNeeded: false,
      reason: null,
    };
  }

  const packaging =
    probe.platform === "darwin" ? "app-bundle" : linuxPackaging(probe, params.linuxPackage);
  if (packaging === "appimage" && params.appImageConflict) {
    return unsupported(params.appImageConflict);
  }
  const sameTarget = probe.platform === client.platform && probe.arch === client.arch;
  const canPush =
    sameTarget &&
    ((packaging === "app-bundle" && client.bundle.kind === "app-bundle") ||
      (packaging === "appimage" && client.bundle.kind === "appimage"));
  const artifactName = artifactNameFor(probe.arch, packaging, client.version);
  const delivery = canPush
    ? "push-bundle"
    : probe.canDownload
      ? "host-fetch"
      : "client-download-push";

  return {
    ...base,
    kind: "install",
    delivery,
    packaging,
    artifactName: delivery === "push-bundle" ? null : artifactName,
    artifactUrl: delivery === "push-bundle" ? null : `${feedUrlFor(client.version)}${artifactName}`,
    // The deb is installed by the user; Daintree restarts nothing for it.
    restartsHost: packaging !== "deb" && probe.appRunning,
    userCommandNeeded: packaging === "deb",
    reason: null,
  };
}

/** The one command a deb install asks the user to run on the host. */
export function debInstallCommand(stagedPath: string): string {
  // The user pastes this into their shell, and a staging path may hold spaces.
  const quoted = /^[A-Za-z0-9._/+-]+$/.test(stagedPath)
    ? stagedPath
    : `'${stagedPath.replace(/'/g, `'"'"'`)}'`;
  return `sudo apt install ${quoted}`;
}
