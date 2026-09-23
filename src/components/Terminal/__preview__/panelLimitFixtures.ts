/**
 * Panel-limit confirm states, each reached through the production seam:
 * `preflightSpawnBatchLimit` against the store's thresholds, exactly as a recipe
 * run or worktree spin-up reaches it.
 */
export interface PanelLimitFixture {
  /** Panels already open when the batch starts. */
  currentCount: number;
  /** Panels the recipe or spin-up asks for. */
  requestedCount: number;
  confirmationLimit: number;
  hardLimit: number;
  /** Recipe name, when the batch is a named recipe run. */
  sourceName?: string;
}

export const PANEL_LIMIT_FIXTURES = {
  /** The common case: a four-terminal recipe pushes 18 open panels past 20. */
  batch: {
    currentCount: 18,
    requestedCount: 4,
    confirmationLimit: 20,
    hardLimit: 32,
    sourceName: "Claude + Codex pair",
  },
  /** One panel over: a cloned one-terminal layout at the threshold, so no recipe name. */
  single: { currentCount: 20, requestedCount: 1, confirmationLimit: 20, hardLimit: 32 },
  /** The hard limit trims the batch: six asked for, three fit. */
  trimmed: {
    currentCount: 29,
    requestedCount: 6,
    confirmationLimit: 20,
    hardLimit: 32,
    sourceName: "Review fleet",
  },
  /** Trimmed to a single panel. */
  "trimmed-one": { currentCount: 31, requestedCount: 5, confirmationLimit: 20, hardLimit: 32 },
  /** A 64 GB machine's hardware defaults with a big recipe — three-digit counts. */
  large: {
    currentCount: 60,
    requestedCount: 12,
    confirmationLimit: 64,
    hardLimit: 100,
    sourceName: "Full-stack sweep: frontend, backend, e2e and docs agents",
  },
} satisfies Record<string, PanelLimitFixture>;

export type PanelLimitFixtureName = keyof typeof PANEL_LIMIT_FIXTURES;

export function requirePanelLimitFixture(name: string): PanelLimitFixture {
  const fixture = (PANEL_LIMIT_FIXTURES as Record<string, PanelLimitFixture>)[name];
  if (!fixture) throw new Error(`Unknown panel-limit fixture "${name}"`);
  return fixture;
}
