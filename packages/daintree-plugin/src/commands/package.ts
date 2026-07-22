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
      dot: false,
      onlyFiles: true,
    })
  );
}

/**
 * Paths the manifest points at, which the archive is invalid without.
 * `verifyPluginArchive` already rejects a missing `main` or view
 * `componentPath`, but only after the `.dntr` has been written — and a dry run
 * never reaches it at all. Skills aren't verified there either: a dropped skill
 * just goes quiet at runtime. Since `.dntrignore` makes excluding these easy for
 * the first time, check them up front instead.
 */
function requiredManifestPaths(manifest: MinimalManifest): string[] {
  const refs = new Set<string>();
  // Normalized exactly the way `verifyPluginArchive` normalizes (strip a
  // leading `./`, nothing else). Being more lenient here — folding backslashes,
  // say — would let a reference pass this check and then fail verification
  // after the archive had already been written, which is the failure mode this
  // check exists to remove.
  const add = (ref?: string) => {
    if (ref) refs.add(ref.startsWith("./") ? ref.slice(2) : ref);
  };
  add(manifest.main);
  for (const view of manifest.contributes?.views ??
    manifest.contributes?.experimental_views ??
    []) {
    add(view.componentPath);
  }
  for (const skill of manifest.contributes?.skills ?? []) {
    add(skill.path);
  }
  return [...refs];
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
  main?: string;
  contributes?: {
    views?: Array<{ componentPath?: string }>;
    /** @deprecated Renamed to `views` in the 1.0 freeze; still honored here. */
    experimental_views?: Array<{ componentPath?: string }>;
    skills?: Array<{ path?: string }>;
  };
}

/**
 * Top-level directories that must be packaged even when `.gitignore` lists them
 * (build output is gitignored by convention but is exactly what ships). Derived
 * from `main` and any view `componentPath`, defaulting to `dist`.
 */
function protectedDirs(manifest: MinimalManifest): string[] {
  const dirs = new Set<string>(["dist"]);
  const add = (ref?: string) => {
    if (!ref) return;
    // The leading `./` has to come off before splitting, or the top segment is
    // "." and a gitignored custom output dir (`main: "./build/index.js"`) never
    // gets preserved — the manifest is valid and the file exists, but it would
    // be left out of the archive.
    const normalized = ref.replace(/\\/g, "/").replace(/^\.\//, "");
    const top = normalized.split("/")[0];
    if (top && top !== "." && top !== "..") dirs.add(top);
  };
  add(manifest.main);
  for (const view of manifest.contributes?.views ??
    manifest.contributes?.experimental_views ??
    []) {
    add(view.componentPath);
  }
  return [...dirs];
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

  const manifest = JSON.parse(
    await fs.readFile(path.join(dir, "plugin.json"), "utf8")
  ) as MinimalManifest;

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
    protectedDirs(manifest).map((d) => `${d}/**/*`),
    { cwd: dir, dot: false, onlyFiles: true }
  );

  // `.dntrignore` prunes the union, including the preserved set: `.gitignore`
  // states repo policy (which is why build output is deliberately un-ignored
  // above), but `.dntrignore` states shipping policy, so it has to reach stray
  // files living *inside* a protected dir — `dist/docs/**` being the case that
  // motivated it.
  const kept = await dntrignoreKept(dir);
  const candidates = new Set<string>([...gitignored, ...preserved].filter((f) => kept.has(f)));
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

  const missing = requiredManifestPaths(manifest).filter((ref) => !files.includes(ref));
  if (missing.length > 0) {
    throw new Error(
      `Manifest references ${missing.length === 1 ? "a file that isn't" : "files that aren't"} in the archive: ${missing.join(", ")}. ` +
        `Check .gitignore and ${DNTRIGNORE_FILENAME}, or run the build first.`
    );
  }

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
