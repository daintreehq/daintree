import fs from "node:fs/promises";
import path from "node:path";
import {
  BUNDLED_SKILLS,
  isBundledSkill,
  loadBundledSkill,
  skillInstallDir,
  type BundledSkill,
} from "../skills.js";

export interface SkillAddOptions {
  /** Plugin directory (default: the cwd). */
  dir?: string;
  /** Replace installed files that differ from the bundled copy. */
  force?: boolean;
  /** Where the bundled skills live. Injected in tests. */
  skillsRoot?: string;
}

export interface SkillAddResult {
  name: BundledSkill;
  /** Absolute path of the installed skill folder. */
  installDir: string;
  /** Paths relative to the plugin root, sorted. */
  written: string[];
  unchanged: string[];
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function lstatOrNull(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Refuse any symlink on the way from the plugin root to `rel`, so an existing
 * `.claude` link can't redirect the write outside the plugin.
 */
async function assertNoSymlink(dir: string, rel: string): Promise<void> {
  let current = dir;
  for (const segment of rel.split("/")) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`${path.relative(dir, current)} is a symlink; refusing to write through it`);
    }
  }
}

/**
 * Copy a bundled Claude Code skill into an existing plugin at
 * `.claude/skills/<name>/`. Every destination is checked before anything is
 * written: an identical file is left alone, and one that differs (an author's
 * edit, or an older copy) is refused unless `force` — never a silent clobber.
 * Files in that folder the bundle doesn't ship are kept.
 */
export async function runSkillAdd(
  name: string,
  opts: SkillAddOptions = {}
): Promise<SkillAddResult> {
  if (!isBundledSkill(name)) {
    throw new Error(`No bundled skill "${name}"; available: ${BUNDLED_SKILLS.join(", ")}`);
  }
  const dir = path.resolve(opts.dir ?? process.cwd());

  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, "plugin.json"), "utf8");
  } catch (error) {
    const reason =
      errorCode(error) === "ENOENT"
        ? `No plugin.json in ${dir}; run this from the plugin's directory`
        : `Couldn't read plugin.json in ${dir}: ${(error as Error).message}`;
    throw new Error(reason, { cause: error });
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error("plugin.json is not valid JSON");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("plugin.json must be a JSON object");
  }
  if (name === "daintree-tour" && (manifest as { scope?: unknown }).scope === "project") {
    throw new Error(
      'This is a project plugin ("scope": "project"), and Daintree refuses tours from project plugins, so the daintree-tour skill has nothing to build here'
    );
  }

  const files = await loadBundledSkill(name, opts.skillsRoot);
  const written: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    await assertNoSymlink(dir, rel);
    const target = path.join(dir, rel);
    const stat = await lstatOrNull(target);
    if (!stat) {
      written.push(rel);
    } else if (!stat.isFile()) {
      throw new Error(`${rel} exists and is not a file`);
    } else if ((await fs.readFile(target, "utf8")) === content) {
      unchanged.push(rel);
    } else if (opts.force) {
      written.push(rel);
    } else {
      conflicts.push(rel);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `These files differ from the bundled skill, so nothing was written:\n${conflicts.map((f) => `  ${f}`).join("\n")}\nRe-run with --force to replace them with this version's copy.`
    );
  }

  for (const rel of written) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, files[rel]!, "utf8");
  }

  return {
    name,
    installDir: path.join(dir, skillInstallDir(name)),
    written: written.sort(),
    unchanged: unchanged.sort(),
  };
}
