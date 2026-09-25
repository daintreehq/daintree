import * as semver from "semver";
import type { PluginManifest } from "../../../../shared/types/plugin.js";
import { findPluginBlocklistMatch, type ParsedPluginBlocklist } from "../PluginBlocklistService.js";
import type { PluginPlatform } from "./inventory.js";

export type PluginInstallRefusal =
  | { kind: "platform"; platform: string; supported: PluginPlatform[] }
  | { kind: "blocklisted"; message: string };

/**
 * Why a package sent from another machine must not be installed here, read
 * from its manifest before anything is extracted into the plugins folder: it
 * has no build for this OS, or the plugin blocklist names this version. The
 * normal install path then validates the rest of the manifest as it always
 * does.
 */
export function pluginInstallRefusal(
  manifest: PluginManifest,
  context: { platform: string; blocklist: ParsedPluginBlocklist | null }
): PluginInstallRefusal | null {
  const declared = (manifest as { platforms?: unknown }).platforms;
  if (Array.isArray(declared) && declared.length > 0 && !declared.includes(context.platform)) {
    return {
      kind: "platform",
      platform: context.platform,
      supported: declared.filter((entry): entry is PluginPlatform => typeof entry === "string"),
    };
  }
  const match = findPluginBlocklistMatch(context.blocklist, {
    name: manifest.name,
    version: manifest.version,
  });
  return match ? { kind: "blocklisted", message: match.message } : null;
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

export function platformDisplayName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/**
 * Whether the package may replace what is installed here, for an install or
 * update a person asked for from another machine: "Install" never replaces an
 * installed copy, and "Update" only ever moves to a newer version. A package
 * dropped with no plugin named replaces as a local install would.
 */
export function replacementRefusal(
  manifest: Pick<PluginManifest, "name" | "version">,
  installedVersion: string | null,
  expect: { pluginId?: string; update?: boolean }
): string | null {
  if (expect.update) {
    if (installedVersion === null) {
      return `"${manifest.name}" is no longer installed, so its update wasn't applied`;
    }
    const next = semver.valid(manifest.version);
    const current = semver.valid(installedVersion);
    if (!next || !current || !semver.gt(next, current)) {
      return `"${manifest.name}" ${installedVersion} is installed; ${manifest.version} isn't newer, so nothing was replaced`;
    }
    return null;
  }
  if (expect.pluginId !== undefined && installedVersion !== null) {
    return `"${manifest.name}" is already installed (${installedVersion}); update it instead`;
  }
  return null;
}
