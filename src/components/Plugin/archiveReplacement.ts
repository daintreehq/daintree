import * as semver from "semver";

/**
 * What approving an archive does to the plugin already installed under its
 * id. `replace` covers the versions that can't be ordered — one side isn't
 * semver, or the two differ only in build metadata, which semver ranks equal.
 */
export type ArchiveReplacementKind = "upgrade" | "reinstall" | "downgrade" | "replace";

export function classifyArchiveReplacement(
  installedVersion: string,
  archiveVersion: string
): ArchiveReplacementKind {
  if (installedVersion === archiveVersion) return "reinstall";
  const installed = semver.valid(installedVersion);
  const archive = semver.valid(archiveVersion);
  if (installed === null || archive === null) return "replace";
  const order = semver.compare(archive, installed);
  if (order > 0) return "upgrade";
  if (order < 0) return "downgrade";
  return "replace";
}
