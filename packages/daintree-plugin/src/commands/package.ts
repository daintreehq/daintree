import fs from "node:fs/promises";
import path from "node:path";
import { globby } from "globby";
import {
  packPluginArchiveFromFiles,
  isExcludedArchiveEntry,
  verifyPluginArchive,
} from "../../../../electron/services/PluginArchive.js";
import { resolveVitePlan, runVitePlanBuild } from "../lib/viteBuild.js";
import { runValidate } from "./validate.js";
import { PROJECT_TEMPLATES_DIR } from "../../../../electron/utils/pluginArchiveConstants.js";
import {
  collectPluginManifestAssets,
  describePluginManifestAsset,
} from "../../../../shared/config/pluginManifestAssets.js";
import { parseJsonText } from "../lib/parseJsonText.js";

/**
 * Per-plugin shipping-policy ignore file, `.gitignore` syntax. Only the archive
 * root is consulted — this is package-level policy (the `.npmignore` analogue),
 * and honoring nested copies would let a vendored asset directory silently
 * rewrite what ships. The file itself never lands in the archive: it's excluded
 * normatively in `PluginArchive.ts` so the host's own packer drops it too.
 */
const DNTRIGNORE_FILENAME = ".dntrignore";

/**
 * The paths `.dntrignore` leaves alone, evaluated WITHOUT `.gitignore`.
 *
 * Passing both files to one globby call folds them into a single ordered rule
 * list, where a negation in either can cancel a rule from the other — a
 * `.gitignore` of `*.md` + `!README.md`, an everyday shape, would re-include a
 * README that `.dntrignore` had excluded. Intersecting two independent passes
 * instead keeps `.dntrignore` strictly subtractive: a path ships only if
 * neither policy drops it, and neither file can un-ignore the other's rules.
 *
 * `node_modules` / `.git` are skipped explicitly because this pass has no
 * `.gitignore` to skip them for it. Both patterns are root-anchored to match
 * the normative exclusion list exactly: a recursively-prefixed form would also
 * drop a nested `dist/node_modules`, which the archive predicate permits and a
 * plugin vendoring its runtime deps genuinely ships.
 */
async function dntrignoreKept(dir: string): Promise<Set<string>> {
  return new Set(
    await globby("**/*", {
      cwd: dir,
      ignoreFiles: [DNTRIGNORE_FILENAME],
      ignore: ["node_modules/**", ".git/**"],
      // Dotfiles too, so a project template's `.gitignore` or `.daintree/`
      // survives the intersection. Harmless for everything else: the other
      // passes still skip dotfiles, and this set only ever narrows them.
      dot: true,
      onlyFiles: true,
    })
  );
}

/**
 * Every file in each declared project template's `project-templates/<id>/`
 * folder (#13825). A template is a project's starting files, so this pass
 * ignores `.gitignore` (a template's own `.gitignore` describes the project it
 * creates, not this plugin) and keeps dotfiles. A symlink is refused rather
 * than dropped: the host copies regular files only, and a template quietly
 * missing a file is worse than a packaging error.
 */
async function projectTemplateFiles(dir: string, manifest: MinimalManifest): Promise<string[]> {
  const ids = (manifest.contributes?.projectTemplates ?? []).map((template) => template.id);
  if (ids.length === 0) return [];
  // The glob starts inside each template folder, so a link at the folder
  // itself (or at `project-templates/`) would be followed without ever being
  // listed. Check those two levels directly.
  for (const rel of [PROJECT_TEMPLATES_DIR, ...ids.map((id) => `${PROJECT_TEMPLATES_DIR}/${id}`)]) {
    const stat = await fs.lstat(path.join(dir, rel)).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new Error(`${rel} is a symbolic link. Project templates must be real folders.`);
    }
  }
  const entries = await globby(
    ids.map((id) => `${PROJECT_TEMPLATES_DIR}/${id}/**/*`),
    {
      cwd: dir,
      dot: true,
      onlyFiles: false,
      followSymbolicLinks: false,
      objectMode: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    }
  );
  const links = entries.filter((entry) => entry.dirent.isSymbolicLink()).map((e) => e.path);
  if (links.length > 0) {
    throw new Error(
      `Project templates may only contain files and folders, not symbolic links: ${links.sort().join(", ")}`
    );
  }
  return entries.filter((entry) => entry.dirent.isFile()).map((entry) => entry.path);
}

export interface PackageOptions {
  dir?: string;
  verbose?: boolean;
  dryRun?: boolean;
  sourcemaps?: boolean;
  skipBuild?: boolean;
}

export interface PackageResult {
  /** Absolute path to the written `.dntr`, or undefined for a dry run. */
  outputPath?: string;
  /** POSIX-relative paths included in the archive, sorted. */
  files: string[];
}

interface MinimalManifest {
  name: string;
  version: string;
  contributes?: {
    projectTemplates?: Array<{ id: string }>;
  };
}

/**
 * Top-level directories that must be packaged even when `.gitignore` lists them
 * (build output is gitignored by convention but is exactly what ships). Derived
 * from every module the manifest names — `main`, views and tour scenes —
 * defaulting to `dist`.
 */
function protectedDirs(manifest: unknown): string[] {
  const dirs = new Set<string>(["dist"]);
  for (const asset of collectPluginManifestAssets(manifest)) {
    if (!asset.module) continue;
    const top = asset.path.replace(/\\/g, "/").split("/")[0];
    if (top && top !== "." && top !== "..") dirs.add(top);
  }
  return [...dirs];
}

/**
 * Check every manifest-referenced file against what will actually ship, before
 * the `.dntr` is written — a dry run never reaches `verifyPluginArchive` at
 * all, and `.dntrignore` makes excluding one of these easy. A required file
 * that is missing, ignored or stripped by the archive filter fails; so does one
 * reached through a symlink that leaves the plugin directory, since globby would
 * otherwise pack whatever the link points at. A missing optional file (local
 * tour narration) only warns: the chapter plays silently.
 */
async function checkManifestAssets(
  dir: string,
  manifest: unknown,
  files: ReadonlySet<string>
): Promise<void> {
  const realDir = await fs.realpath(dir);
  const missing: string[] = [];
  const escaped: string[] = [];
  for (const asset of collectPluginManifestAssets(manifest)) {
    if (!files.has(asset.path)) {
      if (asset.required) missing.push(describePluginManifestAsset(asset));
      else
        console.warn(
          `${describePluginManifestAsset(asset)} isn't in the archive — that chapter will play silently.`
        );
      continue;
    }
    const real = await fs.realpath(path.join(dir, asset.path));
    const relative = path.relative(realDir, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      escaped.push(describePluginManifestAsset(asset));
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Manifest references ${missing.length === 1 ? "a file that isn't" : "files that aren't"} in the archive: ${missing.join(", ")}. ` +
        `Check .gitignore and ${DNTRIGNORE_FILENAME}, or run the build first.`
    );
  }
  if (escaped.length > 0) {
    throw new Error(
      `Manifest references ${escaped.length === 1 ? "a file that resolves" : "files that resolve"} outside the plugin directory through a symlink: ${escaped.join(", ")}. ` +
        `The host refuses these at load; copy the file into the plugin instead.`
    );
  }
}

/**
 * Build (unless `--skip-build`), collect files honoring `.gitignore`, the
 * author's `.dntrignore`, and the normative `.dntr` exclusion list, and write a
 * deterministic
 * `{pluginId}-{version}.dntr`. Reuses the host's archive writer so CLI output
 * is byte-identical to Daintree's own packer on the same OS.
 */
export async function runPackage(opts: PackageOptions = {}): Promise<PackageResult> {
  const dir = path.resolve(opts.dir ?? process.cwd());

  const validation = await runValidate({ dir });
  if (!validation.ok) {
    throw new Error(`Manifest validation failed:\n  ${validation.errors.join("\n  ")}`);
  }

  const rawManifest = parseJsonText(await fs.readFile(path.join(dir, "plugin.json"), "utf8"));
  const manifest = rawManifest as MinimalManifest;

  // A dry run is a no-side-effects preview — never trigger the Vite build.
  // A plugin with a Node server entry needs both passes, or `dist/server.js`
  // ships stale (or missing) while the browser bundle is fresh.
  if (!opts.skipBuild && !opts.dryRun) {
    await runVitePlanBuild(dir, resolveVitePlan(dir));
  }

  // Candidate set honoring .gitignore (drops cruft like .env, coverage/).
  const gitignored = await globby("**/*", {
    cwd: dir,
    gitignore: true,
    dot: false,
    onlyFiles: true,
  });

  // Build output / manifest-referenced dirs must ship even if gitignored.
  const preserved = await globby(
    protectedDirs(rawManifest).map((d) => `${d}/**/*`),
    { cwd: dir, dot: false, onlyFiles: true }
  );

  // `.dntrignore` prunes the union, including the preserved set: `.gitignore`
  // states repo policy (which is why build output is deliberately un-ignored
  // above), but `.dntrignore` states shipping policy, so it has to reach stray
  // files living *inside* a protected dir — `dist/docs/**` being the case that
  // motivated it.
  const templatePayload = await projectTemplateFiles(dir, manifest);

  const kept = await dntrignoreKept(dir);
  const candidates = new Set<string>(
    [...gitignored, ...preserved, ...templatePayload].filter((f) => kept.has(f))
  );
  // The manifest is the one file no policy may drop.
  candidates.add("plugin.json");

  const sourcemaps = opts.sourcemaps ?? false;
  const files = [...candidates]
    .filter((f) => !f.endsWith(".dntr"))
    .filter((f) => !isExcludedArchiveEntry(f, sourcemaps))
    .sort();

  if (!files.includes("plugin.json")) {
    throw new Error("plugin.json not found in the plugin directory");
  }

  const emptyTemplates = (manifest.contributes?.projectTemplates ?? [])
    .map((template) => template.id)
    .filter((id) => !files.some((f) => f.startsWith(`${PROJECT_TEMPLATES_DIR}/${id}/`)));
  if (emptyTemplates.length > 0) {
    throw new Error(
      `Project ${emptyTemplates.length === 1 ? "template has" : "templates have"} no files to ship: ` +
        `${emptyTemplates.map((id) => `${PROJECT_TEMPLATES_DIR}/${id}/`).join(", ")}. ` +
        `Add the template's files there, or check ${DNTRIGNORE_FILENAME}.`
    );
  }

  await checkManifestAssets(dir, rawManifest, new Set(files));

  if (opts.verbose || opts.dryRun) {
    for (const f of files) {
      console.log(`  ${f}`);
    }
  }

  // The schema already rejects non-semver versions before we reach here, but
  // strip any path-significant characters as defense-in-depth so a hostile
  // `"version": "../../x"` can never write the archive outside the plugin dir.
  const safeVersion = manifest.version.replace(/[^\w.-]/g, "");
  const outputName = `${manifest.name}-${safeVersion}.dntr`;
  const outputPath = path.join(dir, outputName);

  if (opts.dryRun) {
    console.log(`Dry run — would write ${outputName} (${files.length} files)`);
    return { files };
  }

  await packPluginArchiveFromFiles(dir, outputPath, files);

  const verifyResult = await verifyPluginArchive(outputPath);
  if (!verifyResult.valid) {
    throw new Error(`Packaged archive failed verification: ${verifyResult.error}`);
  }

  console.log(`Wrote ${outputName} (${files.length} files)`);
  return { outputPath, files };
}
