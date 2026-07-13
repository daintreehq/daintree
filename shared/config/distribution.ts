export function getRuntimePlatform(): string {
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    if (["win32", "darwin", "linux"].includes(process.platform)) {
      return process.platform;
    }
  }

  if (typeof navigator !== "undefined") {
    const platform = navigator.platform?.toUpperCase() ?? "";
    const userAgent = navigator.userAgent ?? "";
    if (platform.includes("WIN") || /\bWindows\b|\bWin(32|64)\b/.test(userAgent)) {
      return "win32";
    }
    if (platform.includes("MAC")) {
      return "darwin";
    }
    if (userAgent.includes("Linux")) {
      return "linux";
    }
  }

  return "unknown";
}

/**
 * Detects MSIX/AppX (Microsoft Store) builds where update delivery is owned by
 * the OS — auto-update IPC and the in-app update UI must be disabled.
 *
 * Reads `process.windowsStore` (set to `true` by Electron only inside an
 * MSIX/AppX container — including sideloaded MSIX). NSIS installer builds
 * leave the property `undefined`, so the function returns `false` there.
 *
 * The renderer sandbox does not expose `process.windowsStore`. Renderer
 * callers must pass the value through (via `HydrateResult.isWindowsStore`)
 * instead of relying on the static default.
 */
export function isWindowsStoreBuild(windowsStore?: boolean): boolean {
  if (typeof windowsStore === "boolean") return windowsStore;
  if (
    typeof process !== "undefined" &&
    typeof (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === "boolean"
  ) {
    return (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true;
  }
  return false;
}

/**
 * Release channel a build was published on, derived from the semver prerelease
 * suffix baked into `app.getVersion()`. This is the single source of truth for
 * build/version provenance — distinct from the user-selected update-feed
 * preference in `AutoUpdaterService` (`updateChannel`), which describes which
 * feed to poll, not what the running binary is.
 */
export type BuildChannel = "stable" | "nightly" | "beta" | "rc";

/**
 * Classifies a version string into its release channel by matching the
 * prerelease suffix. Mirrors the `.includes()` convention in
 * `electron-builder.config.cjs` (the build-time publisher) so runtime UI and
 * the packager agree on channel identity.
 *
 * The nightly workflow strips any existing suffix before stamping
 * `-nightly.*`, so combined tags never occur in the real pipeline; precedence
 * (`nightly > rc > beta`) only matters for manually stamped builds and is kept
 * deterministic regardless. Anything without a recognized suffix — including a
 * plain `1.0.0` stable release — is `"stable"`.
 */
export function getBuildChannel(version: string): BuildChannel {
  if (version.includes("-nightly")) return "nightly";
  if (version.includes("-rc")) return "rc";
  if (version.includes("-beta")) return "beta";
  return "stable";
}

const BUILD_CHANNEL_LABELS = {
  stable: null,
  nightly: "Nightly",
  beta: "Beta",
  rc: "RC",
} satisfies Record<BuildChannel, string | null>;

/**
 * Human-readable channel label for surfacing in UI (About panel, Settings
 * badge). Returns `null` for stable builds so callers render no channel marker
 * at all — a stable release shows only its plain semantic version.
 */
export function getBuildChannelLabel(version: string): string | null {
  return BUILD_CHANNEL_LABELS[getBuildChannel(version)];
}
