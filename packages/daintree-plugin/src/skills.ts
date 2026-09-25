import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Claude Code skills this package ships for plugin authors. They live as real
 * Markdown under the package's `skills/` folder (published via `files`), one
 * level above both `src/` and `dist/`, so the same relative path resolves
 * from source in tests and from the bundle once installed.
 */
export const BUNDLED_SKILLS = ["daintree-tour"] as const;
export type BundledSkill = (typeof BUNDLED_SKILLS)[number];

/** Where a skill lands in a plugin, relative to the plugin root. */
export function skillInstallDir(name: BundledSkill): string {
  return `.claude/skills/${name}`;
}

export function bundledSkillsRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

export function isBundledSkill(name: string): name is BundledSkill {
  return (BUNDLED_SKILLS as readonly string[]).includes(name);
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(dir, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

/**
 * A bundled skill's files keyed by their POSIX path inside the plugin
 * (`.claude/skills/<name>/…`), sorted for stable output.
 */
export async function loadBundledSkill(
  name: BundledSkill,
  root: string = bundledSkillsRoot()
): Promise<Record<string, string>> {
  const dir = path.join(root, name);
  let files: string[];
  try {
    files = await walk(dir);
  } catch (error) {
    throw new Error(
      `The bundled "${name}" skill is missing from ${dir}; this daintree-plugin install is incomplete`,
      { cause: error }
    );
  }
  const out: Record<string, string> = {};
  for (const rel of files.sort()) {
    out[`${skillInstallDir(name)}/${rel}`] = await fs.readFile(path.join(dir, rel), "utf8");
  }
  return out;
}
