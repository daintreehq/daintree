import fs from "node:fs/promises";
import path from "node:path";
import {
  collectPluginManifestAssets,
  describePluginManifestAsset,
  type PluginManifestAsset,
} from "../../../shared/config/pluginManifestAssets.js";

export type PluginAssetProblemKind = "missing" | "outside" | "not-file";

export interface PluginAssetProblem {
  kind: PluginAssetProblemKind;
  message: string;
}

/** `relative` is `path.relative(dir, target)`; a `..assets/` sibling stays inside. */
export function isOutsidePluginDir(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Why one manifest asset in `dir` can't be used, or `null` when it can (#14091).
 * It counts only as a regular file whose realpath stays inside the plugin
 * directory — the loaders contain every read the same way, so a file reached
 * through a link that leaves the plugin is as unusable as a missing one — and
 * whose name is spelled exactly as referenced: a case-insensitive filesystem
 * would otherwise let `skill.md` stand in for the `SKILL.md` the knowledge
 * reader looks up by exact name, and an archive built from it would not.
 */
export async function findPluginAssetProblem(
  realDir: string,
  dir: string,
  asset: PluginManifestAsset
): Promise<PluginAssetProblem | null> {
  const label = describePluginManifestAsset(asset);
  let real: string;
  try {
    real = await fs.realpath(path.join(dir, asset.path));
  } catch {
    return { kind: "missing", message: `${label} is missing from the plugin` };
  }
  if (isOutsidePluginDir(path.relative(realDir, real))) {
    return { kind: "outside", message: `${label} resolves outside the plugin directory` };
  }
  if (!(await fs.stat(real)).isFile()) {
    return { kind: "not-file", message: `${label} is not a file` };
  }
  const name = path.basename(asset.path);
  const siblings = await fs.readdir(path.dirname(path.join(dir, asset.path)));
  if (!siblings.includes(name)) {
    return { kind: "missing", message: `${label} is missing from the plugin (check its case)` };
  }
  return null;
}

/** Every required asset in `dir` that can't be used, worded; `[]` when all can. */
export async function findUnusablePluginAssets(dir: string, manifest: unknown): Promise<string[]> {
  const realDir = await fs.realpath(dir);
  const problems: string[] = [];
  for (const asset of collectPluginManifestAssets(manifest)) {
    if (!asset.required) continue;
    const problem = await findPluginAssetProblem(realDir, dir, asset);
    if (problem) problems.push(problem.message);
  }
  return problems;
}
