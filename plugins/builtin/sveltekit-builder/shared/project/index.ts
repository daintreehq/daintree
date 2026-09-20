import type { ProjectModel } from "../protocol.js";
import { type ProjectFileReader, joinPath, readJsonFile, toWorktreeRelative } from "./fs.js";
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
 * is what turns an ambiguous tree into a question for the user, and
 * `routesDirectory.source` says whether the routes path was read or assumed. `ProjectModelResultSchema` is strict and frozen, so
 * they travel beside it rather than inside it.
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
  { worktreeRoot, appRoot }: InspectProjectArgs
): Promise<ProjectInspection> {
  const manifest = await readJsonFile(reader, joinPath(appRoot, "package.json"));
  const declared = manifest ? declaredDependencies(manifest) : {};

  const [versionReport, packageManager, routesDirectory, installStyle, basePath] =
    await Promise.all([
      readInstalledVersionReport(reader, appRoot, worktreeRoot),
      detectPackageManager(reader, appRoot, worktreeRoot),
      resolveRoutesDirectory(reader, appRoot),
      detectInstallStyle(reader, appRoot, worktreeRoot),
      resolveBasePath(reader, appRoot),
    ]);

  const { versions, resolutions } = versionReport;
  const support = assessSupport(versions, declared, { installStyle, resolutions });
  const { routes, diagnostics } = await analyzeRoutes(reader, {
    appRoot,
    worktreeRoot,
    routesDir: routesDirectory.path,
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
  requestedAppRoot?: string
): Promise<{ apps: SvelteKitApp[]; complete: boolean; inspection: ProjectInspection | null }> {
  const discovery = await discoverSvelteKitApps(reader, worktreeRoot);
  const app = selectApp(discovery, requestedAppRoot);
  if (!app) return { ...discovery, inspection: null };
  const inspection = await inspectProject(reader, { worktreeRoot, appRoot: app.appRoot });
  return { ...discovery, inspection: { ...inspection, app } };
}
