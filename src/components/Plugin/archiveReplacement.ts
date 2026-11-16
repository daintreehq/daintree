import semverCompare from "semver/functions/compare";
import semverValid from "semver/functions/valid";

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
  const installed = semverValid(installedVersion);
  const archive = semverValid(archiveVersion);
  if (installed === null || archive === null) return "replace";
  const order = semverCompare(archive, installed);
  if (order > 0) return "upgrade";
  if (order < 0) return "downgrade";
  return "replace";
}
