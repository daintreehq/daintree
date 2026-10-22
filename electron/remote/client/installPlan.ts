import type { HostArch, HostPlatform } from "../../../shared/types/remoteHosts.js";
import type {
  HostInstallPlan,
  HostProbeResult,
  LinuxPackagePreference,
} from "../../../shared/types/ipc/remoteHosts.js";
import { hostBuildOrder } from "../../../shared/utils/hostBuildOrder.js";

/**
 * Which build a host gets and how it gets there. A host gets exactly this
 * client's version and commit. A host already on a later release is left
 * alone unless the user asks for the downgrade: its newer settings and data
 * may not open in an older build. Otherwise the choice is about delivery:
 *
 * - same platform and arch, and this client has a bundle it can copy: push it;
 * - otherwise the host fetches its artifact for the exact version from the
 *   release feed the updater uses, or, when it has no curl or wget, this
 *   client fetches it and copies it over. A host that has them but can't
 *   reach the feed falls back to the same copy at install time.
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
  // electron-builder's AppImage default: x64 carries no arch, any other arch does.
  return arch === "x64" ? `Daintree-${version}.AppImage` : `Daintree-${version}-${arch}.AppImage`;
}

function linuxPackaging(
  probe: HostProbeResult,
  preference: LinuxPackagePreference | undefined
): "deb" | "appimage" {
  if (preference) return preference;
  // A host already on the deb keeps it; otherwise the AppImage, which installs
  // without root and is the one the release feed publishes a checksum for.
  return probe.install?.packaging === "deb" ? "deb" : "appimage";
}

/**
 * The release a host is ahead on, if it is: what it runs, or what is installed
 * there (an update put in place but not yet restarted into). Null when this
 * client's build is no older than either, or the installed build is only a
 * guess among AppImages, which refuses on its own.
 */
function newerOnHost(
  probe: HostProbeResult,
  client: ClientBuild,
  appImageConflict: string | null | undefined
): string | null {
  if (probe.hostBuild?.order === "newer") return probe.hostBuild.version;
  const installed = appImageConflict ? null : probe.install?.version;
  if (installed && hostBuildOrder({ version: installed, commit: null }, client) === "newer") {
    return installed;
  }
  return null;
}

export function planInstall(params: {
  client: ClientBuild;
  probe: HostProbeResult;
  linuxPackage?: LinuxPackagePreference;
  /** Why the AppImage in use can't be told apart (see ParsedProbe.appImageConflict). */
  appImageConflict?: string | null;
  /** The user asked for this client's build even over a newer one there. */
  allowDowngrade?: boolean;
}): HostInstallPlan {
  const { client, probe } = params;
  const base = {
    version: client.version,
    commit: client.commit,
    channel: client.channel,
    downgrade: false,
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
  const newer = newerOnHost(probe, client, params.appImageConflict);
  if (newer !== null && !params.allowDowngrade) {
    return {
      ...base,
      kind: "host-newer",
      delivery: null,
      packaging: null,
      artifactName: null,
      artifactUrl: null,
      restartsHost: false,
      userCommandNeeded: false,
      reason: `The host has Daintree ${newer}, which is newer than ${client.version} here. Installing this machine's build there would downgrade it.`,
    };
  }

  const packaging =
    probe.platform === "darwin" ? "app-bundle" : linuxPackaging(probe, params.linuxPackage);
  if (packaging === "appimage" && params.appImageConflict) {
    return unsupported(params.appImageConflict);
  }
  // The probe and the host's service keep finding the deb, so an AppImage
  // beside it would install and never run.
  if (packaging === "appimage" && probe.install?.packaging === "deb") {
    return unsupported(
      "This host runs Daintree from the .deb, which can't be switched to the AppImage from here. Update the .deb on the host yourself."
    );
  }
  const restartsHost = packaging !== "deb" && probe.appRunning;
  // Stopping Daintree there installs the update it downloaded, on top of
  // whatever this would put in place.
  if (restartsHost && probe.stagedUpdate?.installsOnQuit) {
    return unsupported(
      `The host has downloaded Daintree ${probe.stagedUpdate.version}, which installs when Daintree there restarts. Install that update first.`
    );
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
    downgrade: newer !== null,
    artifactName: delivery === "push-bundle" ? null : artifactName,
    artifactUrl: delivery === "push-bundle" ? null : `${feedUrlFor(client.version)}${artifactName}`,
    // The deb is installed by the user; Daintree restarts nothing for it.
    restartsHost,
    userCommandNeeded: packaging === "deb",
    reason: null,
  };
}

/**
 * The one command a deb install asks the user to run on the host. It checks
 * the package is still the one Daintree verified before sudo touches it.
 */
export function debInstallCommand(stagedPath: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Not a sha256");
  // The user pastes this into their shell, and a staging path may hold spaces.
  const quoted = /^[A-Za-z0-9._/+-]+$/.test(stagedPath)
    ? stagedPath
    : `'${stagedPath.replace(/'/g, `'"'"'`)}'`;
  return `printf '%s  %s\\n' ${sha256} ${quoted} | sha256sum -c --quiet - && sudo apt install ${quoted}`;
}
