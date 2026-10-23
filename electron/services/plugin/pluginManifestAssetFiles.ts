import fs from "node:fs/promises";
import path from "node:path";
import {
  collectPluginManifestAssets,
  describePluginManifestAsset,
} from "../../../shared/config/pluginManifestAssets.js";

/**
 * Why each required manifest asset in `dir` can't be used, or `[]` when all of
 * them can (#14091). An asset counts only when it is a regular file whose
 * realpath stays inside the plugin directory: the loaders contain every read
 * the same way, so a file reached through a link that leaves the plugin is as
 * unusable as a missing one. Optional assets (local tour narration) are skipped.
 */
export async function findUnusablePluginAssets(dir: string, manifest: unknown): Promise<string[]> {
  const realDir = await fs.realpath(dir);
  const problems: string[] = [];
  for (const asset of collectPluginManifestAssets(manifest)) {
    if (!asset.required) continue;
    const label = describePluginManifestAsset(asset);
    let real: string;
    try {
      real = await fs.realpath(path.join(dir, asset.path));
    } catch {
      problems.push(`${label} is missing from the plugin`);
      continue;
    }
    const relative = path.relative(realDir, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      problems.push(`${label} resolves outside the plugin directory`);
      continue;
    }
    if (!(await fs.stat(real)).isFile()) {
      problems.push(`${label} is not a file`);
    }
  }
  return problems;
}
