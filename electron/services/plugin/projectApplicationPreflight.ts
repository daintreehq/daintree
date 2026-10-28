import type {
  PluginManifest,
  ProjectApplicationPreflightReason,
} from "../../../shared/types/plugin.js";
import { collectPluginManifestAssets } from "../../../shared/config/pluginManifestAssets.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { createLogger } from "../../utils/logger.js";
import {
  readPluginDatabaseSchemaVersion,
  resolvePluginDatabaseLocation,
} from "./pluginDatabase.js";
import { findUnusablePluginAssets } from "./pluginManifestAssetFiles.js";

const logger = createLogger("main:projectApplicationPreflight");

export interface ProjectApplicationPreflightFailure {
  reason: ProjectApplicationPreflightReason;
  problems: string[];
}

/**
 * Check an application payload on disk before any of its code is loaded
 * (#14113): every file its manifest needs is there, and no database it
 * declares a `schemaVersion` for was written by a newer copy of it. Reads
 * only — it creates no directory or database, migrates nothing, and runs
 * nothing.
 *
 * The first failing class wins, files before data: a payload missing its own
 * files says nothing reliable about what schema it means.
 *
 * Fails open. A check that cannot be made (an unreadable file, a location that
 * no longer resolves) is logged and skipped, because refusing on it would hide
 * the application over a question nobody answered; the handle still refuses a
 * newer file under its write lock when the code opens it.
 */
export async function preflightProjectApplication(args: {
  dir: string;
  manifest: Readonly<PluginManifest>;
  projectRoot: string;
  dataDir: string;
}): Promise<ProjectApplicationPreflightFailure | null> {
  const { dir, manifest, projectRoot, dataDir } = args;

  let missing: string[] = [];
  try {
    missing = await findUnusablePluginAssets(dir, manifest);
  } catch (err) {
    logger.warn("Project application asset preflight could not run", {
      manifestId: manifest.name,
      error: formatErrorMessage(err, "asset check failed"),
    });
  }
  if (missing.length > 0) return { reason: "assets-missing", problems: missing };

  const tooNew: string[] = [];
  for (const declaration of manifest.contributes.databases ?? []) {
    const declared = declaration.schemaVersion;
    if (declared === undefined) continue;
    try {
      const location = await resolvePluginDatabaseLocation({
        declaration,
        manifestId: manifest.name,
        projectRoot,
        dataDir,
        existingOnly: true,
      });
      const found = readPluginDatabaseSchemaVersion(location);
      if (found > declared) {
        tooNew.push(
          `database "${declaration.id}" is at schema version ${found}, but version ${manifest.version} declares ${declared}`
        );
      }
    } catch (err) {
      // Not created yet: the first open will create it at this payload's schema.
      if ((err as { code?: unknown }).code === "DB_NOT_FOUND") continue;
      logger.warn("Project application database preflight could not read a schema version", {
        manifestId: manifest.name,
        databaseId: declaration.id,
        error: formatErrorMessage(err, "schema read failed"),
      });
    }
  }
  if (tooNew.length > 0) return { reason: "schema-too-new", problems: tooNew };

  return null;
}

/**
 * Everything checked about an application before it loads — whether it is one,
 * its engine range, and what {@link preflightProjectApplication} reads — as
 * one comparable string. The loader re-reads `plugin.json` after the check, so
 * a rewrite landing in between would otherwise run a payload nobody checked;
 * two manifests with the same key were checked by the same pass.
 */
export function applicationPreflightKey(manifest: Readonly<PluginManifest>): string {
  return JSON.stringify([
    manifest.application !== undefined,
    manifest.engines?.daintree ?? null,
    manifest.version,
    collectPluginManifestAssets(manifest).map((asset) => [asset.path, asset.required]),
    (manifest.contributes.databases ?? []).map((d) => [
      d.id,
      d.location,
      d.path ?? null,
      d.schemaVersion ?? null,
    ]),
  ]);
}
