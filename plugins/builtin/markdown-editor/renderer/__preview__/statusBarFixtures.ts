import type { MarkdownEditorStatusBarProps } from "../MarkdownEditorStatusBar";

type FixtureProps = Omit<MarkdownEditorStatusBarProps, "onSave">;

export interface StatusBarFixture {
  /** What this case is here to prove. */
  what: string;
  props: FixtureProps;
}

const BASE: FixtureProps = {
  lineCount: 117,
  byteLength: 12_392,
  hasBom: false,
  eolLabel: "LF",
  mixedEol: false,
  dirty: false,
  saving: false,
  saveBlocked: false,
};

/**
 * Every state the strip carries design weight in. `saved` is the resting case
 * the screenshot in the brief showed; the rest are the ones nobody looks at.
 */
export const STATUS_BAR_FIXTURES: Record<string, StatusBarFixture> = {
  saved: { what: "at rest — the case that is on screen almost all the time", props: BASE },
  dirty: {
    what: "unsaved edits — the only state where the action is live",
    props: { ...BASE, dirty: true },
  },
  saving: {
    what: "the write in flight",
    props: { ...BASE, dirty: true, saving: true },
  },
  conflict: {
    what: "saving held by a disk conflict — action present but refused",
    props: { ...BASE, dirty: true, saveBlocked: true },
  },
  "mixed-eol": {
    what: "the second metadata run, which competes with the first",
    props: { ...BASE, dirty: true, mixedEol: true },
  },
  bom: {
    what: "the longest the left run ever gets",
    props: { ...BASE, hasBom: true, eolLabel: "CRLF", mixedEol: true, dirty: true },
  },
  empty: {
    what: "a new file — every metric at its shortest",
    props: { ...BASE, lineCount: 0, byteLength: 0 },
  },
};

export function requireStatusBarFixture(name: string): StatusBarFixture {
  const found = STATUS_BAR_FIXTURES[name];
  if (!found) {
    throw new Error(
      `unknown fixture "${name}" — one of ${Object.keys(STATUS_BAR_FIXTURES).join(", ")}`
    );
  }
  return found;
}
