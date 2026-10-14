// Type surface for host-css.mjs so the type-checked contract suites can import
// it. The .mjs stays plain JS because the build scripts read it too.

/** Absolute path of `src/index.css`, the host stylesheet entry. */
export const HOST_CSS_ENTRY: string;

/** The entry-relative directory the entry's own rules were split into. */
export const HOST_PARTIAL_DIR: string;

export interface HostStylesheet {
  /** The entry with each host-partial import replaced in place by the partial's text. */
  css: string;
  /** The entry, then each partial in import order, with the text read from each. */
  files: { path: string; source: string }[];
}

/** `src/index.css` with its host partials expanded in place. */
export function readHostStylesheet(
  entry?: string,
  options?: { onFile?: (file: string) => void }
): HostStylesheet;
