import fs from "node:fs/promises";
import path from "node:path";
import { globby } from "globby";
import {
  packPluginArchiveFromFiles,
  isExcludedArchiveEntry,
  verifyPluginArchive,
} from "../../../../electron/services/PluginArchive.js";
import { runViteBuild } from "../lib/viteBuild.js";
import { runValidate } from "./validate.js";

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
    const normalized = ref.replace(/\\/g, "/");
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
 * Build (unless `--skip-build`), collect files honoring `.gitignore` plus the
 * normative `.dntr` exclusion list, and write a deterministic
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
  if (!opts.skipBuild && !opts.dryRun) {
    await runViteBuild(dir);
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

  const candidates = new Set<string>([...gitignored, ...preserved, "plugin.json"]);

  const sourcemaps = opts.sourcemaps ?? false;
  const files = [...candidates]
    .filter((f) => !f.endsWith(".dntr"))
    .filter((f) => !isExcludedArchiveEntry(f, sourcemaps))
    .sort();

  if (!files.includes("plugin.json")) {
    throw new Error("plugin.json not found in the plugin directory");
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
