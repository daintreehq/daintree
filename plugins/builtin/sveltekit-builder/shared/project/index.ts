import type { ProjectModel } from "../protocol.js";
import {
  type ProjectFileReader,
  type ProjectReadOptions,
  joinPath,
  readJsonFile,
  toWorktreeRelative,
} from "./fs.js";
import {
  declaredDependencies,
  discoverSvelteKitApps,
  selectApp,
  type SvelteKitApp,
} from "./discovery.js";
import { detectPackageManager, type PackageManagerDetection } from "./packageManager.js";
import {
  analyzeRoutes,
  resolveBasePath,
  resolveRoutesDirectory,
  type RouteDiagnostic,
  type RoutesDirectory,
} from "./routes.js";
import {
  assessSupport,
  detectInstallStyle,
  readInstalledVersionReport,
  type SupportAssessment,
} from "./versions.js";

export * from "./fs.js";
export * from "./discovery.js";
export * from "./packageManager.js";
export * from "./routes.js";
export * from "./versions.js";

/**
 * Everything the setup card needs, alongside the wire-shaped `model`.
 *
 * The extras are not decoration: `missingInstall` separates "run install" from
 * "installed at a version we never tested against", `packageManager.conflict`
 * is what turns an ambiguous tree into a question for the user.
 *
 * `routesDirectory` and `routeDiagnostics` are here in the richer form the
 * resolver returns — absolute paths — and also on `model`, worktree-relative:
 * a consumer on the far side of IPC needs to know whether the route list was
 * read or assumed just as much as the setup card does.
 */
export interface ProjectInspection {
  model: ProjectModel;
  app: SvelteKitApp | null;
  support: SupportAssessment;
  packageManager: PackageManagerDetection;
  routesDirectory: RoutesDirectory;
  /** Route-tree problems SvelteKit itself would reject, and walks that stopped early. */
  routeDiagnostics: RouteDiagnostic[];
}

export interface InspectProjectArgs {
  worktreeRoot: string;
  appRoot: string;
  /** Ends the inspection as an abort rather than as an empty reading. */
  signal?: AbortSignal;
}

/**
 * Read one SvelteKit app: which package manager runs it, whether its installed
 * toolchain is one the bundled compiler was tested against, and what routes it
 * has.
 *
 * Reads only. Detection never installs a package, executes project code, or
 * rewrites configuration — the app may be a repository the user has not yet
 * chosen to trust.
 */
export async function inspectProject(
  reader: ProjectFileReader,
  { worktreeRoot, appRoot, signal }: InspectProjectArgs
): Promise<ProjectInspection> {
  const reads: ProjectReadOptions = signal ? { signal } : {};
  const manifest = await readJsonFile(reader, joinPath(appRoot, "package.json"), reads);
  const declared = manifest ? declaredDependencies(manifest) : {};

  const [versionReport, packageManager, installStyle] = await Promise.all([
    readInstalledVersionReport(reader, appRoot, worktreeRoot),
    detectPackageManager(reader, appRoot, worktreeRoot),
    detectInstallStyle(reader, appRoot, worktreeRoot),
  ]);

  const { versions, resolutions } = versionReport;
  // The installed Kit decides whether a config handed to the Vite plugin is
  // read at all, so the version has to be known before the config is — and
  // "known" means the copy we read is the one the app resolves. Under
  // Plug'n'Play it is not: a stale `node_modules` left by a previous linker
  // answers for a package the loader never loads, and the support verdict
  // already says so. Reading the gate off that copy would have one inspection
  // calling the same file unauthoritative and authoritative at once.
  const authoritativeKit =
    installStyle === "pnp" || resolutions?.kit === "unresolved" ? null : versions.kit;
  const configReads = { ...reads, kitVersion: authoritativeKit };
  const [routesDirectory, basePath] = await Promise.all([
    resolveRoutesDirectory(reader, appRoot, configReads),
    resolveBasePath(reader, appRoot, configReads),
  ]);

  const support = assessSupport(versions, declared, { installStyle, resolutions });

  const { routes, diagnostics } = await analyzeRoutes(reader, {
    appRoot,
    worktreeRoot,
    routesDir: routesDirectory.path,
    ...(signal && { signal }),
  });

  const name = manifest?.["name"];
  return {
    model: {
      appRoot,
      packageManager: packageManager.name,
      versions,
      support: support.verdict,
      routes,
      basePath,
      routesDirectory: {
        path: toWorktreeRelative(worktreeRoot, routesDirectory.path),
        source: routesDirectory.source,
      },
      routeDiagnostics: diagnostics,
    },
    app: manifest
      ? {
          appRoot,
          relativePath: toWorktreeRelative(worktreeRoot, appRoot),
          packageName: typeof name === "string" && name.length > 0 ? name : null,
          declaredKitRange: declared["@sveltejs/kit"] ?? "",
        }
      : null,
    support,
    packageManager,
    routesDirectory,
    routeDiagnostics: diagnostics,
  };
}

/**
 * Discover the apps in a worktree and inspect the one the caller named, or the
 * only one there is. `inspection` stays null when the choice is genuinely the
 * user's — several apps and no `appRoot` — so a caller cannot accidentally bind
 * the builder to whichever app sorted first.
 */
export async function inspectWorktree(
  reader: ProjectFileReader,
  worktreeRoot: string,
  requestedAppRoot?: string,
  options: ProjectReadOptions = {}
): Promise<{ apps: SvelteKitApp[]; complete: boolean; inspection: ProjectInspection | null }> {
  const discovery = await discoverSvelteKitApps(reader, worktreeRoot, options);
  const app = selectApp(discovery, requestedAppRoot);
  if (!app) return { ...discovery, inspection: null };
  const inspection = await inspectProject(reader, {
    worktreeRoot,
    appRoot: app.appRoot,
    ...(options.signal && { signal: options.signal }),
  });
  return { ...discovery, inspection: { ...inspection, app } };
}
