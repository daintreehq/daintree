import { parseConfigListing } from "./parseGitRecords.js";

/**
 * The filter drivers a config listing (`git config -z --list`) gives a clean
 * or process program. The listing is read as bytes rather than through a key
 * regexp, which would run under a UTF-8 locale where a subsection name that
 * isn't valid UTF-8 can fail to match, and that driver would then run
 * unswitched.
 */
export function filterDriversIn(listing: Buffer): string[] {
  const drivers = new Set<string>();
  for (const { key } of parseConfigListing(listing)) {
    const text = key.toString("utf8");
    if (!/^filter\..+\.(clean|process|required)$/s.test(text)) continue;
    // The override is handed to git as text; a name it can't carry exactly
    // would switch off some other driver and leave this one running.
    if (!Buffer.from(text, "utf8").equals(key)) {
      throw new Error("A filter driver's name isn't valid UTF-8, so it can't be switched off.");
    }
    drivers.add(text.slice("filter.".length, text.lastIndexOf(".")));
  }
  return [...drivers];
}

/** Switch a driver's clean side off, and stop git failing a path for lacking it. */
export function disableFilters(drivers: readonly string[]): Array<readonly [string, string]> {
  return drivers.flatMap((name) => [
    [`filter.${name}.clean`, ""] as const,
    [`filter.${name}.process`, ""] as const,
    [`filter.${name}.required`, "false"] as const,
  ]);
}
