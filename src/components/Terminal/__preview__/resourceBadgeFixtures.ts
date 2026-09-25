import type { AgentState } from "@/types";
import type { TerminalResourceProcess } from "@shared/types/pty-host";

// Type-only imports, on purpose: the screenshot spec imports this catalogue under
// Playwright's Node loader, where anything that reaches Vite-only code fails to
// evaluate.

/**
 * One pane's worth of resource telemetry for the resource-badge review harness.
 *
 * `cpu` is the sequence of samples the pty-host would have sent, oldest first. The
 * preview replays them through the real `resourceMonitoringStore.updateMetrics`,
 * one batch per tick, so the header's own severity hysteresis decides the colour —
 * a fixture never names a severity, it earns one.
 */
export interface ResourceBadgeFixture {
  what: string;
  /** Pane width in CSS px. The grid's common 2×2 pane is ~560; 320 is the pressure case. */
  width?: number;
  title: string;
  agentId?: "claude" | "codex" | "gemini";
  agentState?: AgentState;
  isFocused?: boolean;
  cpu: number[];
  /** Memory for every sample, or one value per sample. */
  memoryKb: number | number[];
  breakdown?: TerminalResourceProcess[];
  /** Processes in the tree when `breakdown` is the capped top ten. */
  processCount?: number;
  queueCount?: number;
  sessionCost?: number;
  sessionTokens?: number;
  isInputLocked?: boolean;
}

/** A deterministic wobble, so every run draws the same line. */
function wobble(length: number, base: number, amp: number, seed: number): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 9301 + 49297) % 233280;
    out.push(Math.max(0, base + ((s / 233280) * 2 - 1) * amp));
  }
  return out;
}

const NODE_BREAKDOWN: TerminalResourceProcess[] = [
  { pid: 48213, comm: "node", cpuPercent: 61.4, memoryKb: 612_000 },
  { pid: 48190, comm: "vitest", cpuPercent: 8.2, memoryKb: 180_400 },
  { pid: 48102, comm: "zsh", cpuPercent: 0.1, memoryKb: 4_200 },
];

const CLAUDE_BREAKDOWN: TerminalResourceProcess[] = [
  { pid: 51022, comm: "claude", cpuPercent: 3.1, memoryKb: 286_000 },
  { pid: 51040, comm: "rg", cpuPercent: 0.4, memoryKb: 12_800 },
  { pid: 51001, comm: "zsh", cpuPercent: 0, memoryKb: 4_100 },
];

const BUILD_BREAKDOWN: TerminalResourceProcess[] = [
  { pid: 60311, comm: "cargo", cpuPercent: 212.6, memoryKb: 1_320_000 },
  { pid: 60388, comm: "rustc", cpuPercent: 96.3, memoryKb: 940_000 },
  { pid: 60390, comm: "rustc", cpuPercent: 88.1, memoryKb: 610_000 },
  { pid: 60290, comm: "zsh", cpuPercent: 0, memoryKb: 4_300 },
];

export const FIXTURES = {
  idle: {
    what: "an agent sitting at its prompt — the state most panes are in most of the time",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "waiting",
    cpu: wobble(30, 1.2, 1, 7),
    memoryKb: 290_000,
    breakdown: [
      { pid: 51022, comm: "claude", cpuPercent: 1.1, memoryKb: 281_000 },
      { pid: 51001, comm: "zsh", cpuPercent: 0.1, memoryKb: 4_100 },
    ],
  },
  working: {
    what: "an agent thinking and calling tools — bursty, well under any threshold",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "working",
    isFocused: true,
    cpu: [
      2, 3, 14, 22, 9, 4, 3, 18, 31, 26, 12, 6, 4, 3, 21, 38, 29, 17, 8, 5, 4, 12, 27, 33, 19, 9, 6,
      14, 24, 17,
    ],
    memoryKb: 312_000,
    breakdown: [
      { pid: 51022, comm: "claude", cpuPercent: 13.6, memoryKb: 294_000 },
      { pid: 51040, comm: "rg", cpuPercent: 3.4, memoryKb: 12_800 },
      { pid: 51001, comm: "zsh", cpuPercent: 0, memoryKb: 4_100 },
    ],
  },
  warm: {
    what: "a test watcher sustained over 50% — the amber band, earned through hysteresis",
    title: "npm test -- --watch",
    // The last sample is the breakdown's sum, as the pty-host would report it.
    cpu: [...wobble(12, 18, 6, 3), ...wobble(17, 64, 7, 11), 69.7],
    memoryKb: 796_000,
    breakdown: NODE_BREAKDOWN,
  },
  hot: {
    what: "a release build pegging several cores — ps reports 380%, over the 100% the line can draw",
    title: "cargo build --release",
    // The last sample is the breakdown's sum, as the pty-host would report it.
    cpu: [...wobble(6, 40, 20, 5), ...wobble(23, 360, 50, 13), 397],
    memoryKb: [
      ...Array.from({ length: 12 }, (_, i) => 900_000 + i * 60_000),
      ...Array.from({ length: 18 }, () => 2_874_000),
    ],
    breakdown: BUILD_BREAKDOWN,
  },
  "memory-heavy": {
    what: "quiet CPU but a language server holding 2.3G — red earned by memory alone, its row kept past the cap",
    title: "Codex: port the billing worker",
    agentId: "codex",
    agentState: "working",
    cpu: [...wobble(29, 6, 4, 19), 6.6],
    memoryKb: 2_411_000,
    processCount: 14,
    breakdown: [
      { pid: 70101, comm: "codex", cpuPercent: 4.2, memoryKb: 238_000 },
      { pid: 70160, comm: "node", cpuPercent: 0.6, memoryKb: 61_000 },
      { pid: 70161, comm: "esbuild", cpuPercent: 0.5, memoryKb: 24_000 },
      { pid: 70162, comm: "rg", cpuPercent: 0.4, memoryKb: 12_800 },
      { pid: 70163, comm: "git", cpuPercent: 0.3, memoryKb: 9_400 },
      { pid: 70164, comm: "node", cpuPercent: 0.2, memoryKb: 48_000 },
      { pid: 70165, comm: "prettier", cpuPercent: 0.2, memoryKb: 31_000 },
      { pid: 70166, comm: "eslint_d", cpuPercent: 0.1, memoryKb: 88_000 },
      { pid: 70100, comm: "zsh", cpuPercent: 0.1, memoryKb: 4_100 },
      { pid: 70144, comm: "tsserver", cpuPercent: 0, memoryKb: 1_874_000 },
    ],
  },
  cooled: {
    what: "a spike that just ended — history shows it, the band has de-escalated",
    title: "npm run build",
    cpu: [...wobble(8, 4, 2, 23), ...wobble(10, 92, 6, 29), ...wobble(11, 3, 2, 31), 2.4],
    memoryKb: 402_000,
    breakdown: [
      { pid: 52210, comm: "node", cpuPercent: 2.3, memoryKb: 380_000 },
      { pid: 52190, comm: "zsh", cpuPercent: 0.1, memoryKb: 4_200 },
    ],
  },
  "just-started": {
    what: "the second sample after enabling monitoring — the shortest line the badge draws",
    title: "Gemini: audit accessibility",
    agentId: "gemini",
    agentState: "working",
    cpu: [0, 12],
    memoryKb: 96_000,
    breakdown: [
      { pid: 53301, comm: "gemini", cpuPercent: 12, memoryKb: 91_800 },
      { pid: 53300, comm: "zsh", cpuPercent: 0, memoryKb: 4_200 },
    ],
  },
  crowded: {
    what: "a 360px pane with a settled cost readout and a queue — telemetry clips first",
    width: 360,
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "completed",
    queueCount: 2,
    sessionCost: 1.84,
    sessionTokens: 412_000,
    cpu: wobble(30, 22, 12, 37),
    memoryKb: 512_000,
    breakdown: CLAUDE_BREAKDOWN,
  },
} satisfies Record<string, ResourceBadgeFixture>;

export type FixtureName = keyof typeof FIXTURES;
export const FIXTURE_NAMES = Object.keys(FIXTURES).filter(
  (key): key is FixtureName => key in FIXTURES
);

/** Fixtures whose breakdown the harness opens: over one core, and past the row cap. */
export const TOOLTIP_FIXTURES: FixtureName[] = ["hot", "memory-heavy"];
