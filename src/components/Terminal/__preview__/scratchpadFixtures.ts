import type { TerminalScratchpad } from "@shared/types/panel";

/**
 * Scratchpad states for the visual-review harness. Type-only imports: the
 * screenshot spec reads `SCRATCHPAD_FIXTURE_NAMES` under Playwright's Node
 * loader, where anything that reaches `import.meta.glob` fails.
 */
export interface ScratchpadFixture {
  what: string;
  scratchpad: TerminalScratchpad;
  /** Width of the whole pane frame; the column is capped at half of it. */
  paneWidth?: number;
}

const NOTES = [
  "## After this run",
  "- rerun `npm test -- src/auth` once the rotate fix lands",
  "- check the refresh race on a cold cache",
  "",
  "Ask about the 401 on /session — flaky or real?",
  "",
  "npm run db:generate && npm run check",
].join("\n");

const LONG = Array.from(
  { length: 6 },
  (_, i) =>
    `## Pass ${i + 1}\n- read session.ts and tokens.ts\n- note every place that trusts expiresAt\n- rerun the auth suite with --reporter=verbose\n`
).join("\n");

export const SCRATCHPAD_FIXTURES = {
  empty: {
    what: "Just opened from the overflow menu, nothing written yet",
    scratchpad: { content: "", collapsed: false },
  },
  notes: {
    what: "A few working notes at the default width",
    scratchpad: { content: NOTES, collapsed: false },
  },
  long: {
    what: "More notes than fit, so the editor scrolls",
    scratchpad: { content: LONG, collapsed: false },
  },
  narrow: {
    what: "Notes at the minimum column width",
    scratchpad: { content: NOTES, collapsed: false, width: 200 },
  },
  wide: {
    what: "Notes dragged out to a wide column",
    scratchpad: { content: NOTES, collapsed: false, width: 420 },
    paneWidth: 980,
  },
  collapsed: {
    what: "Hidden with notes in it — the header keeps the way back",
    scratchpad: { content: NOTES, collapsed: true },
  },
} as const satisfies Record<string, ScratchpadFixture>;

export type ScratchpadFixtureName = keyof typeof SCRATCHPAD_FIXTURES;

export const SCRATCHPAD_FIXTURE_NAMES = Object.keys(SCRATCHPAD_FIXTURES) as ScratchpadFixtureName[];

export function isScratchpadFixtureName(value: string): value is ScratchpadFixtureName {
  return value in SCRATCHPAD_FIXTURES;
}
