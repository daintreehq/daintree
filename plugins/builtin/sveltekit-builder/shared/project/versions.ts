import { SUPPORTED_BASELINE } from "../model.js";
import type { SupportVerdict } from "../protocol.js";
import {
  type ProjectFileReader,
  directoriesUpTo,
  fileExists,
  joinPath,
  readJsonFileResult,
} from "./fs.js";

/** Wire key → npm package name. The wire keys are frozen by `ProjectModelResultSchema`. */
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
 * resolved 5.x, or `"^5"` in a tree nobody has installed. A visual editor that
 * writes Svelte 5 syntax on the strength of a caret range corrupts the project.
 *
 * The lookup climbs from the app root to the worktree root because a workspace
 * install hoists: `apps/site` usually has no `node_modules/svelte` of its own,
 * only a link or nothing at all, with the real copy at the repo root.
 */
export async function readInstalledVersionReport(
  reader: ProjectFileReader,
  appRoot: string,
  worktreeRoot: string
): Promise<InstalledVersionReport> {
  const searchDirs = directoriesUpTo(appRoot, worktreeRoot);
  const entries = await Promise.all(
    (Object.keys(TRACKED_PACKAGES) as TrackedPackageKey[]).map(async (key) => {
      for (const dir of searchDirs) {
        const result = await readJsonFileResult(
          reader,
          joinPath(dir, "node_modules", TRACKED_PACKAGES[key], "package.json")
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
  worktreeRoot: string
): Promise<InstalledVersions> {
  return (await readInstalledVersionReport(reader, appRoot, worktreeRoot)).versions;
}

/**
 * How the project's dependencies are on disk.
 *
 * `pnp` matters because it is the one case where "no `node_modules/svelte`"
 * does not mean "not installed": Yarn Plug'n'Play resolves out of a zip cache
 * and there is nothing for us to read. Telling that user to run install would
 * be wrong advice, and calling their project unsupported would be a lie.
 */
export type InstallStyle = "node-modules" | "pnp";

const PNP_MARKERS = [".pnp.cjs", ".pnp.loader.mjs", ".pnp.js"];

export async function detectInstallStyle(
  reader: ProjectFileReader,
  appRoot: string,
  worktreeRoot: string
): Promise<InstallStyle> {
  for (const dir of directoriesUpTo(appRoot, worktreeRoot)) {
    for (const marker of PNP_MARKERS) {
      if (await fileExists(reader, joinPath(dir, marker))) return "pnp";
    }
  }
  return "node-modules";
}

/**
 * Major of a complete version, or null when the string is not a version at all
 * — `workspace:*`, a git URL, a `file:` link, `5.garbage`.
 *
 * The whole string is validated, not just its prefix. A prefix match would read
 * `5.garbage` as Svelte 5 and hand the project full editing support on the
 * strength of a typo. Prereleases count as their own major, so `5.0.0-next.42`
 * is Svelte 5 — the baseline is about the API generation, not about stability.
 */
const SEMVER = /^v?(\d+)(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function majorVersion(version: string | null): number | null {
  if (!version) return null;
  const match = SEMVER.exec(version.trim());
  if (!match?.[1]) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * The packages whose major decides direct editing. A range, not a floor: source
 * is parsed with the bundled Svelte compiler and located through the dev
 * runtime's `__svelte_meta`, so a newer major inherits nothing it was not
 * tested against. Tailwind is not here — edits write class tokens exactly as
 * typed, and class awareness is gated on its own, by the Tailwind loader.
 */
const GATED: ReadonlyArray<{ key: TrackedPackageKey; major: number }> = [
  { key: "svelte", major: SUPPORTED_BASELINE.svelteMajor },
  { key: "kit", major: SUPPORTED_BASELINE.kitMajor },
];

export interface SupportAssessment {
  verdict: SupportVerdict;
  versions: InstalledVersions;
  /**
   * Declared in `package.json` but absent from every `node_modules` we looked
   * in. Structurally distinct from "too old" because the remedy is different
   * and the UI must say so: this is "run install", not "unsupported project".
   * A caller that offers a recovery action keys off this, not off the prose.
   */
  missingInstall: TrackedPackageKey[];
}

/**
 * The gate. `full` needs Svelte and Kit installed at the supported major;
 * anything else is `preview-only` with a reason per failing
 * package that names the package and the version actually found.
 *
 * Vite is read and reported but never gates: the baseline pins no Vite major,
 * and refusing to open a site because its bundler is a version we did not
 * anticipate would be a guess dressed as a policy. No verdict here implies
 * migration — nothing in this module writes.
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

  for (const { key, major: supported } of GATED) {
    const pkg = TRACKED_PACKAGES[key];
    const installed = versions[key];
    const isDeclared = typeof declared[pkg] === "string";

    // Under Plug'n'Play nothing on the filesystem is authoritative: the loader
    // resolves from a zip cache, so a stale `node_modules` left over from a
    // previous linker would answer for a package the app never loads. We do not
    // execute `.pnp.cjs` to find out, so the honest verdict is preview-only.
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
    if (major < supported) {
      reasons.push(`${pkg} ${installed} is installed; direct editing needs ${pkg} ${supported}`);
    } else if (major > supported) {
      reasons.push(
        `${pkg} ${installed} is newer than direct editing supports (${pkg} ${supported}); inspecting and asking an agent still work`
      );
    }
  }

  return {
    verdict: reasons.length === 0 ? { level: "full" } : { level: "preview-only", reasons },
    versions,
    missingInstall,
  };
}
