import { promises as fs } from "fs";
import path from "path";

import { describeManifestIssues, getPluginManifestSchema } from "../../schemas/plugin.js";
import type { PluginManifest } from "../../../shared/types/plugin.js";

/** Where a project keeps its own plugins, relative to the project root. */
export const PROJECT_PLUGINS_DIR_SEGMENTS = [".daintree", "plugins"] as const;

/**
 * Hard cap on a `plugin.json` read. A manifest is a few kilobytes; anything
 * past this is either a mistake or an attempt to make discovery expensive on a
 * folder the user has not trusted yet. Discovery runs on every project open,
 * before any trust decision, so it must stay cheap and bounded.
 */
const MANIFEST_BYTE_CAP = 512 * 1024;

/** One directory found under `<projectRoot>/.daintree/plugins/`. */
export interface DiscoveredProjectPlugin {
  /** Directory name. Deliberately NOT required to equal the manifest id. */
  dirName: string;
  /** Realpath-resolved absolute directory, contained in the project root. */
  dir: string;
  /** Present iff the manifest parsed and validated under the `"project"` origin. */
  manifest?: Readonly<PluginManifest>;
  /** Human-readable rejection reason. Present iff `manifest` is absent. */
  error?: string;
}

export interface ProjectPluginDiscoveryResult {
  /** Realpath of the plugins root, or `null` when the project has no such folder. */
  root: string | null;
  /** Every directory found, valid or not, in directory-name order. */
  plugins: DiscoveredProjectPlugin[];
}

/** Is `candidate` inside (or equal to) `root`? Both must already be realpaths. */
function isContained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Enumerate and validate a project's own plugins.
 *
 * **This function executes nothing.** It reads and parses `plugin.json`, and
 * that is the whole of its filesystem contact: it never stats `dist/`, never
 * resolves `main`, never imports a module and never forks a worker. That is a
 * hard property, not an implementation detail — discovery runs before the trust
 * gate, on a folder that anyone who can push to the repository (agents very
 * much included) can write, so a project the user has never trusted must be
 * fully describable without a single line of its code having run.
 *
 * Symlink containment matches the `plugin://` protocol handler: every candidate
 * is realpath-resolved and checked against the realpath-resolved project root,
 * so a directory or a `plugin.json` that links out of the project is rejected
 * at discovery rather than followed.
 */
export async function discoverProjectPlugins(
  projectRoot: string
): Promise<ProjectPluginDiscoveryResult> {
  let realProjectRoot: string;
  try {
    realProjectRoot = await fs.realpath(projectRoot);
  } catch {
    // The project folder itself is gone or unreadable. Nothing to discover;
    // this is not an error the user needs told about here — the project
    // check service owns "your project moved".
    return { root: null, plugins: [] };
  }

  const pluginsRoot = path.join(realProjectRoot, ...PROJECT_PLUGINS_DIR_SEGMENTS);

  let realPluginsRoot: string;
  try {
    realPluginsRoot = await fs.realpath(pluginsRoot);
  } catch {
    return { root: null, plugins: [] };
  }
  if (!isContained(realProjectRoot, realPluginsRoot)) {
    // `.daintree/plugins` is itself a symlink pointing out of the project.
    // Refusing the whole root is the only safe read of that.
    return { root: null, plugins: [] };
  }

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(realPluginsRoot, { withFileTypes: true });
  } catch {
    return { root: null, plugins: [] };
  }

  // Dot-prefixed names are skipped for the same reason the installed-plugin
  // scan skips them: a plugin id is `publisher.name` and a publisher segment
  // can never start with a dot, so `.git`, `.DS_Store` and editor scratch dirs
  // are never candidate plugins.
  const candidates = entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  const schema = getPluginManifestSchema("project");
  const plugins: DiscoveredProjectPlugin[] = [];

  for (const dirName of candidates) {
    const discovered = await inspectCandidate(realProjectRoot, realPluginsRoot, dirName, schema);
    if (discovered) plugins.push(discovered);
  }

  return { root: realPluginsRoot, plugins };
}

async function inspectCandidate(
  realProjectRoot: string,
  realPluginsRoot: string,
  dirName: string,
  schema: ReturnType<typeof getPluginManifestSchema>
): Promise<DiscoveredProjectPlugin | null> {
  const candidateDir = path.join(realPluginsRoot, dirName);

  let realDir: string;
  try {
    realDir = await fs.realpath(candidateDir);
  } catch {
    // Broken symlink or a race with a delete. Not worth a row.
    return null;
  }

  if (!isContained(realProjectRoot, realDir)) {
    return {
      dirName,
      dir: candidateDir,
      error: `"${dirName}" links outside the project and was not read`,
    };
  }

  let stat: import("fs").Stats;
  try {
    stat = await fs.stat(realDir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const manifestPath = path.join(realDir, "plugin.json");
  let realManifestPath: string;
  try {
    realManifestPath = await fs.realpath(manifestPath);
  } catch {
    // No plugin.json — a stray folder under `.daintree/plugins/`, not a
    // plugin. Silent: the user may well be keeping notes there.
    return null;
  }
  if (!isContained(realProjectRoot, realManifestPath)) {
    return {
      dirName,
      dir: realDir,
      error: `"${dirName}/plugin.json" links outside the project and was not read`,
    };
  }

  let raw: string;
  try {
    const manifestStat = await fs.stat(realManifestPath);
    if (!manifestStat.isFile()) return null;
    if (manifestStat.size > MANIFEST_BYTE_CAP) {
      return {
        dirName,
        dir: realDir,
        error: `"${dirName}/plugin.json" is larger than ${MANIFEST_BYTE_CAP} bytes`,
      };
    }
    raw = await fs.readFile(realManifestPath, "utf-8");
  } catch (err) {
    return { dirName, dir: realDir, error: describeError(err) };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { dirName, dir: realDir, error: `"${dirName}/plugin.json" is not valid JSON` };
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      dirName,
      dir: realDir,
      error: describeManifestIssues(parsed.error.issues, schema),
    };
  }

  // Note what is deliberately NOT checked here: that `dirName` equals
  // `manifest.name`. Nothing in this codebase enforces that today — the
  // shipping `plugins/builtin/github` directory declares `daintree.github` —
  // and introducing the rule for project plugins alone would make the two
  // roots disagree about what a plugin folder is.
  return { dirName, dir: realDir, manifest: parsed.data };
}
