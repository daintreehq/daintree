/**
 * The toolchain majors the bundled Svelte compiler was proven against. Read
 * against installed packages, never against the ranges a manifest declares.
 */
export const SUPPORTED_BASELINE = {
  svelteMajor: 5,
  kitMajor: 2,
  tailwindMajor: 4,
} as const;

/**
 * Major of a complete version, or null when the string is not a version at all
 * — `workspace:*`, a git URL, a `file:` link, `5.garbage`.
 *
 * The whole string is validated, not just its prefix. A prefix match would read
 * `5.garbage` as Svelte 5 and call the toolchain tested on the strength of a
 * typo. Prereleases count as their own major, so `5.0.0-next.42`
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
 * The packages whose major the support verdict reports on. A range, not a
 * floor: source is parsed with the bundled Svelte compiler and located through
 * the dev runtime's `__svelte_meta`, so a newer major inherits nothing it was
 * not tested against. Tailwind is not here — the builder reads its version for the
 * agent's context and nothing else.
 */
export const TESTED_AGAINST: ReadonlyArray<{
  key: TestedPackageKey;
  label: string;
  major: number;
}> = [
  { key: "svelte", label: "Svelte", major: SUPPORTED_BASELINE.svelteMajor },
  { key: "kit", label: "SvelteKit", major: SUPPORTED_BASELINE.kitMajor },
];

/** The subset of tracked packages the verdict speaks about. */
export type TestedPackageKey = "svelte" | "kit";

/**
 * The same observation as the verdict's reasons, from installed versions alone:
 * "Svelte 4.2.1 (tested against Svelte 5)".
 *
 * A caller that holds only the versions — the agent prompt, which lists them
 * already — can say what the verdict says without carrying the verdict's
 * install-style evidence. It claims no more than the versions it was handed do:
 * these are what was read from disk, which under Plug'n'Play is not necessarily
 * what the app resolves, so the note names a version rather than a resolution.
 * Versions with no readable major say nothing at all — absent and unreadable
 * are the assessment's business, not a note about skew.
 */
export function untestedVersionNotes(
  versions: Readonly<Record<TestedPackageKey, string | null>>
): string[] {
  const notes: string[] = [];
  for (const { key, label, major: tested } of TESTED_AGAINST) {
    const installed = versions[key];
    const major = majorVersion(installed);
    if (installed === null || major === null || major === tested) continue;
    notes.push(`${label} ${installed} (tested against ${label} ${tested})`);
  }
  return notes;
}
