/**
 * The file browser's panel title, composed in one place and taken apart in one
 * place. The grid header wants the kind spelled out ("Files — develop"); a dock
 * chip already carries the folder-tree icon and can only afford the part that
 * tells one browser from another. Both halves live here so the chip trims what
 * the action composed instead of pattern-matching a format it can't see change.
 */
export const FILE_BROWSER_TITLE_PREFIX = "Files — ";

/** Grid/dialog header title for a browser rooted at `name`. */
export function composeFileBrowserTitle(name: string): string {
  return `${FILE_BROWSER_TITLE_PREFIX}${name}`;
}

/**
 * The distinguishing half of a composed title, for surfaces too narrow for the
 * prefix. A user-renamed title (or any title this module didn't compose) is
 * returned untouched — trimming a prefix it never carried would be a guess.
 */
export function compactFileBrowserTitle(title: string): string {
  return title.startsWith(FILE_BROWSER_TITLE_PREFIX)
    ? title.slice(FILE_BROWSER_TITLE_PREFIX.length)
    : title;
}
