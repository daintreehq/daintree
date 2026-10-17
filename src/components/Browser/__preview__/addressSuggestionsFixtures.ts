/**
 * States of the browser address bar's history suggestions.
 *
 * Type imports only: the screenshot spec imports this module under Playwright's
 * Node loader, where anything reaching `import.meta.glob` fails to load.
 */

export const PROJECT_ID = "5b0d6f4e2a9c71c3e8a41f20";
export const PANEL_ID = "browser-3f9a1c2e-77d0";

export interface AddressSuggestionsFixture {
  /** Pane width in CSS px. The grid gives a pane anything from ~420 to the full window. */
  width: number;
  /** Pane height in CSS px when not the default 440; a short grid row clips the list. */
  height?: number;
  /** "browser" for the plain browser panel, "dev-preview" for its proxied twin. */
  host: "browser" | "dev-preview";
  /** What gets typed into the focused address bar. */
  query: string;
  /** What the spec does once the list is open. */
  drive:
    | "typed"
    | "keyboard-first"
    | "keyboard-long"
    | "hover-row"
    | "hover-remove"
    | "keyboard-removed";
  /** The highlighted row is cut, so the list spells out its whole destination. */
  revealsDestination?: boolean;
}

export const ADDRESS_SUGGESTION_FIXTURES = {
  typed: { width: 900, host: "browser", query: "git", drive: "typed" },
  "keyboard-first": { width: 900, host: "browser", query: "git", drive: "keyboard-first" },
  "keyboard-long": {
    width: 900,
    host: "browser",
    query: "git",
    drive: "keyboard-long",
    revealsDestination: true,
  },
  "hover-row": { width: 900, host: "browser", query: "git", drive: "hover-row" },
  "hover-remove": { width: 900, host: "browser", query: "git", drive: "hover-remove" },
  "keyboard-removed": { width: 900, host: "browser", query: "git", drive: "keyboard-removed" },
  untitled: { width: 900, host: "browser", query: "local", drive: "keyboard-first" },
  "narrow-typed": { width: 480, host: "browser", query: "git", drive: "typed" },
  "narrow-keyboard": {
    width: 480,
    host: "browser",
    query: "git",
    drive: "keyboard-long",
    revealsDestination: true,
  },
  "narrow-hover-remove": { width: 480, host: "browser", query: "git", drive: "hover-remove" },
  "dev-preview": { width: 900, host: "dev-preview", query: "/", drive: "keyboard-long" },
  "short-pane": {
    width: 900,
    height: 300,
    host: "browser",
    query: "git",
    drive: "keyboard-long",
    revealsDestination: true,
  },
} as const satisfies Record<string, AddressSuggestionsFixture>;

export type AddressSuggestionsFixtureName = keyof typeof ADDRESS_SUGGESTION_FIXTURES;

export const ADDRESS_SUGGESTION_FIXTURE_NAMES = Object.keys(ADDRESS_SUGGESTION_FIXTURES).filter(
  isAddressSuggestionsFixtureName
);

export function isAddressSuggestionsFixtureName(
  value: string
): value is AddressSuggestionsFixtureName {
  return value in ADDRESS_SUGGESTION_FIXTURES;
}

/** The row `keyboard-long` arrows to: the one whose address is too long to show whole. */
export const LONG_ROW_MATCH = /docs\.github\.com|settings\?tab=billing/;
