import {
  TESTED_AGAINST,
  majorVersion,
} from "../../../../../shared/elementPicker/sveltekit/versionNotes.js";
import type { SupportVerdict } from "./model.js";
import {
  type ProjectFileReader,
  type ProjectReadOptions,
  directoriesUpTo,
  fileExists,
  joinPath,
  readJsonFileResult,
} from "../fs.js";

/** Wire key → npm package name. The wire keys are the ones `ProjectModelResultSchema` names. */
export const TRACKED_PACKAGES = {
  svelte: "svelte",
  kit: "@sveltejs/kit",
  tailwind: "tailwindcss",
  vite: "vite",
} as const;

export type TrackedPackageKey = keyof typeof TRACKED_PACKAGES;

export type InstalledVersions = Record<TrackedPackageKey, string | null>;

/**
 * Why a package has no version, separated from the version itself.
 *
 * `unresolved` is the one that matters: a nearer copy exists but its manifest
 * could not be read or parsed. Climbing past it would report the version of a
 * *different* copy of the package than the app actually loads.
 */
export type VersionResolution = "resolved" | "absent" | "unresolved";

export type VersionResolutions = Record<TrackedPackageKey, VersionResolution>;

export interface InstalledVersionReport {
  versions: InstalledVersions;
  resolutions: VersionResolutions;
}

/**
 * Versions as installed, read from each package's own `package.json`.
 *
 * Not from the ranges in the app's manifest, which are a statement of intent
 * and routinely wrong: `"svelte": "^4.0.0"` in a tree where the lockfile
 * resolved 5.x, or `"^5"` in a tree nobody has installed. Parsing source with
 * the compiler a caret range implied, rather than the one the app installed,
 * misreads the file it is tracing.
 *
 * The lookup climbs from the app root to the worktree root because a workspace
 * install hoists: `apps/site` usually has no `node_modules/svelte` of its own,
 * only a link or nothing at all, with the real copy at the repo root.
 */
export async function readInstalledVersionReport(
  reader: ProjectFileReader,
  appRoot: string,
  worktreeRoot: string,
  options: ProjectReadOptions = {}
): Promise<InstalledVersionReport> {
  const searchDirs = directoriesUpTo(appRoot, worktreeRoot);
  const entries = await Promise.all(
    (Object.keys(TRACKED_PACKAGES) as TrackedPackageKey[]).map(async (key) => {
      for (const dir of searchDirs) {
        const result = await readJsonFileResult(
          reader,
          joinPath(dir, "node_modules", TRACKED_PACKAGES[key], "package.json"),
          options
        );
        if (result.status === "missing") continue;
        const version = result.value?.["version"];
        if (typeof version === "string" && version.length > 0) {
          return [key, { version, resolution: "resolved" as VersionResolution }] as const;
        }
        // Present but unusable. Stop here rather than reporting an outer copy.
        return [key, { version: null, resolution: "unresolved" as VersionResolution }] as const;
      }
      return [key, { version: null, resolution: "absent" as VersionResolution }] as const;
    })
  );

  const versions = {} as InstalledVersions;
  const resolutions = {} as VersionResolutions;
  for (const [key, entry] of entries) {
    versions[key] = entry.version;
    resolutions[key] = entry.resolution;
  }
  return { versions, resolutions };
}

export async function readInstalledVersions(
  reader: ProjectFileReader,
  appRoot: string,
  worktreeRoot: string,
  options: ProjectReadOptions = {}
): Promise<InstalledVersions> {
  return (await readInstalledVersionReport(reader, appRoot, worktreeRoot, options)).versions;
}

/**
 * How the project's dependencies are on disk.
 *
 * `pnp` matters because it is the one case where "no `node_modules/svelte`"
 * does not mean "not installed": Yarn Plug'n'Play resolves out of a zip cache
 * and there is nothing for us to read. Telling that user to run install would
 * be wrong advice: the verdict says instead that the versions the app actually
 * resolves could not be established, which is what we know.
 */
export type InstallStyle = "node-modules" | "pnp";

const PNP_MARKERS = [".pnp.cjs", ".pnp.loader.mjs", ".pnp.js"];

export async function detectInstallStyle(
  reader: ProjectFileReader,
  appRoot: string,
  worktreeRoot: string,
  options: ProjectReadOptions = {}
): Promise<InstallStyle> {
  for (const dir of directoriesUpTo(appRoot, worktreeRoot)) {
    options.signal?.throwIfAborted();
    for (const marker of PNP_MARKERS) {
      if (await fileExists(reader, joinPath(dir, marker), options)) return "pnp";
    }
  }
  return "node-modules";
}

export interface SupportAssessment {
  verdict: SupportVerdict;
  versions: InstalledVersions;
  /**
   * Declared in `package.json` but absent from every `node_modules` we looked
   * in. Structurally distinct from "too old" because the remedy is different
   * and the UI must say so: this is "run install", not "a version we never
   * tested against".
   * A caller that offers a recovery action keys off this, not off the prose.
   */
  missingInstall: TrackedPackageKey[];
}

/**
 * A diagnostic, not a gate. `tested` means Svelte and Kit are installed at the
 * majors the bundled compiler was proven against; anything else is `untested`,
 * with a reason per package naming it and the version actually found.
 *
 * Nothing keys off the verdict to withhold a capability: an untested toolchain
 * is still traced, and its selection still goes to an agent. Vite is reported
 * but absent here — the baseline pins no Vite major, and naming a bundler
 * version we did not anticipate would be a guess dressed as a finding. No
 * verdict here implies migration — nothing in this module writes.
 */
export interface AssessSupportOptions {
  installStyle?: InstallStyle;
  resolutions?: VersionResolutions;
}

export function assessSupport(
  versions: InstalledVersions,
  declared: Readonly<Record<string, string>>,
  options: InstallStyle | AssessSupportOptions = {}
): SupportAssessment {
  const { installStyle = "node-modules", resolutions } =
    typeof options === "string" ? { installStyle: options, resolutions: undefined } : options;
  const reasons: string[] = [];
  const missingInstall: TrackedPackageKey[] = [];

  for (const { key, major: tested } of TESTED_AGAINST) {
    const pkg = TRACKED_PACKAGES[key];
    const installed = versions[key];
    const isDeclared = typeof declared[pkg] === "string";

    // Under Plug'n'Play nothing on the filesystem is authoritative: the loader
    // resolves from a zip cache, so a stale `node_modules` left over from a
    // previous linker would answer for a package the app never loads. We do not
    // execute `.pnp.cjs` to find out, so the honest verdict is untested.
    if (installStyle === "pnp") {
      reasons.push(
        installed === null
          ? `${pkg} could not be read: this project uses Yarn Plug'n'Play, which resolves packages without a node_modules directory`
          : `${pkg} reads as ${installed} on disk, but this project uses Yarn Plug'n'Play and that copy is not what the app resolves`
      );
      continue;
    }

    if (resolutions?.[key] === "unresolved") {
      reasons.push(`${pkg} is installed but its package.json could not be read`);
      continue;
    }

    if (installed === null) {
      if (isDeclared) {
        missingInstall.push(key);
        reasons.push(
          `${pkg} is declared as ${declared[pkg]} but is not installed — install dependencies and reopen`
        );
      } else {
        reasons.push(`${pkg} is not a dependency of this app`);
      }
      continue;
    }

    const major = majorVersion(installed);
    if (major === null) {
      reasons.push(`${pkg} resolved to "${installed}", which has no readable major version`);
      continue;
    }
    if (major < tested) {
      reasons.push(
        `${pkg} ${installed} is installed; the Element Picker is tested against ${pkg} ${tested}`
      );
    } else if (major > tested) {
      reasons.push(
        `${pkg} ${installed} is newer than the Element Picker was tested against (${pkg} ${tested})`
      );
    }
  }

  return {
    verdict: reasons.length === 0 ? { level: "tested" } : { level: "untested", reasons },
    versions,
    missingInstall,
  };
}
