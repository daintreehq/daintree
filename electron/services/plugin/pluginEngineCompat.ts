import * as semver from "semver";

/**
 * How the running Daintree version misses a plugin's `engines.daintree` range.
 * `app-too-old` sits below every version the range admits, `app-too-new` above
 * every one, and `outside-range` falls in a gap of a disjoint range.
 */
export type PluginEngineMismatch = "app-too-old" | "app-too-new" | "outside-range";

/**
 * Compare the running version against a plugin's declared `engines.daintree`
 * range. Returns `null` when it satisfies the range. The result is advisory: an
 * unmet range loads with a warning rather than blocking the plugin (#12589).
 *
 * Local builds are stamped `<next minor>.0-dev.<stamp>`, and a prerelease sorts
 * below its release even with `includePrerelease`, so `0.37.0-dev.x` misses
 * `>=0.37.0`. Retrying against the coerced release treats a dev build as the
 * release it is working toward.
 */
export function checkPluginEngineRange(
  appVersion: string,
  range: string
): PluginEngineMismatch | null {
  const options = { includePrerelease: true };
  if (semver.satisfies(appVersion, range, options)) return null;
  const release = semver.coerce(appVersion);
  if (release && semver.satisfies(release, range)) return null;
  // `ltr`/`gtr` throw on a version they can't parse.
  if (!semver.valid(appVersion)) return "outside-range";
  if (semver.ltr(appVersion, range, options)) return "app-too-old";
  if (semver.gtr(appVersion, range, options)) return "app-too-new";
  return "outside-range";
}
