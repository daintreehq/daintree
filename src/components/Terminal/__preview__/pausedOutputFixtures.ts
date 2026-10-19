import type { PersistableFlowStatus } from "@shared/types/panel";

// Type-only imports: the capture spec loads this file under Playwright's Node
// loader, where the agent icon registry's `import.meta.glob` cannot evaluate.

export interface PausedOutputFixture {
  what: string;
  flowStatus?: PersistableFlowStatus;
  submitStatus?: "slow";
  /** The pty-host's `pause-duration-gauge` value; absent before its first tick. */
  heldDurationMs?: number;
}

export const FIXTURES = {
  paused: {
    what: "output held for backpressure, twelve seconds in",
    flowStatus: "paused-backpressure",
    heldDurationMs: 12_000,
  },
  "paused-no-gauge": {
    what: "the first moments of a hold, before the duration gauge has ticked",
    flowStatus: "paused-backpressure",
  },
  "paused-long": {
    what: "a hold on a view that was frozen while hidden — the longest duration string",
    flowStatus: "paused-backpressure",
    heldDurationMs: 3_725_000,
  },
  "paused-sending": {
    what: "held output and a prompt still sending — both sections in one tooltip",
    flowStatus: "paused-backpressure",
    submitStatus: "slow",
    heldDurationMs: 12_000,
  },
  sending: {
    what: "a prompt still sending on its own — the sibling section",
    submitStatus: "slow",
  },
} as const satisfies Record<string, PausedOutputFixture>;

export type FixtureName = keyof typeof FIXTURES;
export const FIXTURE_NAMES = Object.keys(FIXTURES) as FixtureName[];
