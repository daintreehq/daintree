/**
 * The user outcomes this product is judged on, and what currently measures them.
 *
 * WHY A MANIFEST AND NOT MORE BENCHMARKS
 *   The matrix — every id in `scenarios/index.ts`'s `EXPECTED_SCENARIO_IDS` —
 *   is very good at answering "which subsystem moved". It cannot answer "would
 *   a user notice", because almost
 *   every scenario ends below the renderer — and the handful of Playwright
 *   benchmarks that do reach a painted result were, until recently, not even
 *   listed in `npm run perf list`. This file is the missing index: one row per
 *   outcome, naming the command that measures it end to end and the mechanism
 *   scenarios that explain a movement in it.
 *
 *   That direction matters. A journey regression tells you the product got
 *   worse; the linked scenarios tell you where to look. Neither replaces the
 *   other, and the link is what makes the pair usable without a person holding
 *   the whole matrix in their head.
 *
 * HONESTY ABOUT COVERAGE
 *   `coverage` states what actually exists today, not what should. `partial`
 *   means the benchmark stops short of the usable endpoint the outcome names —
 *   most commonly at "the promise resolved" rather than "the user could type" —
 *   and `gap` means nothing measures it at all. Those are not TODOs to be
 *   quietly upgraded: a row marked `full` must be able to point at a command
 *   whose end condition is a correct visible or usable result.
 *
 * OWNER PATHS
 *   Globs over the product source. `perf affected` maps a diff onto them, so a
 *   person changing terminal input can see which outcomes are downstream of it
 *   before, rather than after, they measure the wrong thing. Every path is
 *   checked against the real tree by the manifest test — a glob matching nothing
 *   is a rename that silently disconnected an outcome from its code.
 */

export type JourneyCoverage = "full" | "partial" | "gap";

export interface JourneyDefinition {
  id: string;
  name: string;
  /** The question a user would ask, in their words. */
  userQuestion: string;
  /** Where the measurement must start to be honest about this outcome. */
  startBoundary: string;
  /** What has to be true before the outcome counts as delivered. */
  usableEndBoundary: string;
  coverage: JourneyCoverage;
  /**
   * `npm run perf <command>` names that measure this outcome today, in order of
   * how directly. Empty when `coverage` is `gap`.
   */
  commands: readonly string[];
  /** Why the coverage is what it is — the shortfall, stated plainly. */
  coverageNote: string;
  /** Mechanism scenarios that explain a movement in this outcome. */
  linkedScenarios: readonly string[];
  /** Product source globs whose changes should send someone to this row. */
  ownerPaths: readonly string[];
}

export const JOURNEYS: readonly JourneyDefinition[] = [
  {
    id: "JOURNEY-001",
    name: "Launch to a usable terminal",
    userQuestion: "How long after opening Daintree can I type into the terminal I meant to use?",
    startBoundary: "OS process spawn",
    usableEndBoundary:
      "the intended project is active, its terminal has real geometry, history has replayed, focus is on it, and a probe keystroke reaches the PTY and is painted exactly once",
    coverage: "partial",
    commands: ["launch-ab", "cold-start"],
    coverageNote:
      "Both measure a real packaged launch to the app's own boot marks. Neither continues to a focused terminal that accepts a keystroke, so a regression that leaves the app 'ready' with an unusable terminal would not move either number.",
    linkedScenarios: [
      "PERF-001",
      "PERF-002",
      "PERF-003",
      "PERF-004",
      "PERF-010",
      "PERF-080",
      "PERF-195",
      "PERF-196",
      "PERF-220",
      "PERF-350",
    ],
    ownerPaths: [
      "electron/main.ts",
      "electron/window/**",
      "electron/services/**",
      "src/services/terminal/**",
      "src/store/**",
    ],
  },
  {
    id: "JOURNEY-002",
    name: "Project switch to visible and input-ready",
    userQuestion: "After I pick another project, when can I see it and safely keep typing?",
    startBoundary: "the click, shortcut or switcher selection",
    usableEndBoundary:
      "the target view is the visible top child, the old project intercepts nothing, the right terminal is attached at sane geometry, and input reaches the target PTY and no other",
    coverage: "partial",
    commands: ["project-switch"],
    coverageNote:
      "The spec measures a real switch round trip and the app's own reveal telemetry, which is genuinely user-facing. It does not send an input probe to the target PTY, so 'visible' is proven and 'input-ready' is not — and #11900 showed a terminal can hold the right text at a geometry that makes its history unusable.",
    linkedScenarios: [
      "PERF-010",
      "PERF-011",
      "PERF-012",
      "PERF-013",
      "PERF-070",
      "PERF-071",
      "PERF-072",
      "PERF-073",
      "PERF-074",
      "PERF-075",
      "PERF-076",
      "PERF-077",
      "PERF-110",
      "PERF-111",
      "PERF-112",
      "PERF-195",
      "PERF-196",
    ],
    ownerPaths: [
      "electron/window/**",
      "src/services/terminal/**",
      "src/store/**",
      "src/components/Terminal/**",
    ],
  },
  {
    id: "JOURNEY-003",
    name: "Foreground terminal stays responsive under fleet load",
    userQuestion:
      "While several agents are busy, does the terminal I am using still feel immediate and behave correctly?",
    startBoundary: "a real keydown, paste, submit, Ctrl+C or wheel event",
    usableEndBoundary:
      "the correct painted result, with the exact PTY byte sequence intact — no dropped, duplicated, reordered or cross-terminal input",
    coverage: "partial",
    commands: ["interactivity", "scroll"],
    coverageNote:
      "Keystroke-to-paint and wheel-to-paint under fleet load are measured through the real path. The rest of the interaction set is not: paste drain, submit boundaries, a second submit during a slow first (#11875), interrupt-to-prompt, and search highlight paint. PERF-036 grades the submit byte tape below the renderer, which is the ordering half of that gap.",
    linkedScenarios: [
      "PERF-030",
      "PERF-031",
      "PERF-032",
      "PERF-033",
      "PERF-034",
      "PERF-035",
      "PERF-036",
      "PERF-110",
      "PERF-111",
      "PERF-112",
      "PERF-193",
      "PERF-194",
      "PERF-370",
      "PERF-371",
      "PERF-372",
      "PERF-373",
      "PERF-380",
      "PERF-381",
      "PERF-382",
      "PERF-383",
      "PERF-384",
    ],
    ownerPaths: [
      "src/services/terminal/**",
      "electron/services/pty/**",
      "electron/pty-host/**",
      "shared/utils/agentFsm.ts",
    ],
  },
  {
    id: "JOURNEY-004",
    name: "Filesystem mutation to correct visible state",
    userQuestion:
      "After the repository changes, how quickly does every Daintree surface show the new truth?",
    startBoundary: "a real filesystem write, rename or delete after watchers are ready",
    usableEndBoundary:
      "the first presented frame containing the exact correct row, status or diff — with no stale row left at the old path and the row reachable by an actual click",
    coverage: "gap",
    commands: [],
    coverageNote:
      "Nothing measures the last mile. PERF-100..106 and PERF-130..142 prove the signal reaches the store, and PERF-240..246 prove the sweep runs, but no benchmark carries a mutation through React, virtualization and paint. This is the largest single hole in the suite, and #11334, #12087 and #12094 are all failures that lived inside it. PERF-142 closes the part of #11334 that is reachable without a renderer: it proves the store distinguishes an ignored-only write from a status poll, which is the signal the File Browser refreshes on. What is still unmeasured above it is whether the React hook reads that signal and whether a row is painted.",
    linkedScenarios: [
      "PERF-100",
      "PERF-101",
      "PERF-102",
      "PERF-103",
      "PERF-104",
      "PERF-105",
      "PERF-106",
      "PERF-130",
      "PERF-133",
      "PERF-134",
      "PERF-135",
      "PERF-140",
      "PERF-141",
      "PERF-142",
      "PERF-240",
      "PERF-241",
      "PERF-242",
      "PERF-243",
      "PERF-400",
      "PERF-401",
      "PERF-402",
    ],
    ownerPaths: [
      "electron/services/git/**",
      "src/components/Sidebar/**",
      "src/panels/file-browser/**",
      "src/store/**",
    ],
  },
  {
    id: "JOURNEY-005",
    name: "Fleet launch without freezing the terminal already in use",
    userQuestion:
      "When I launch several agents at once, how quickly do they become useful — and does Daintree stay usable while it happens?",
    startBoundary: "the recipe-run, agent-launch or bulk-create action",
    usableEndBoundary:
      "first, median and all terminals painted, correctly assigned and accepting a probe input, with the foreground terminal's latency measured throughout",
    coverage: "partial",
    commands: ["recipe-fanout", "bulk-issue-worktrees", "agent-launch", "worktree-agent-ready"],
    coverageNote:
      "All four cross the real production path to a painted terminal with real PTYs. None keeps a foreground terminal under input while the fan-out runs, so a candidate that fans out 10% faster by monopolising the main thread would score as an improvement.",
    linkedScenarios: [
      "PERF-150",
      "PERF-151",
      "PERF-200",
      "PERF-201",
      "PERF-350",
      "PERF-351",
      "PERF-352",
      "PERF-353",
      "PERF-370",
      "PERF-371",
    ],
    ownerPaths: [
      "src/services/actions/**",
      "electron/services/pty/**",
      "electron/ipc/handlers/**",
      "src/services/terminal/**",
    ],
  },
  {
    id: "JOURNEY-006",
    name: "Long-session responsiveness and state integrity",
    userQuestion:
      "After hours of switching, launching, editing and streaming, is Daintree still as responsive and correct as it was at startup?",
    startBoundary: "a fresh app session",
    usableEndBoundary:
      "the same interaction latencies and the same expected topology after N realistic work cycles, with scrollback, geometry and focus intact",
    coverage: "partial",
    commands: ["memory", "memory-growth", "memory-pressure"],
    coverageNote:
      "Retained memory and responsiveness under pressure are measured. Interaction latency ACROSS the session is not: nothing reports whether typing got slower by cycle 30, which is the half users report and memory graphs miss.",
    linkedScenarios: [
      "PERF-060",
      "PERF-061",
      "PERF-062",
      "PERF-063",
      "PERF-074",
      "PERF-075",
      "PERF-076",
      "PERF-077",
      "PERF-092",
      "PERF-093",
      "PERF-094",
      "PERF-260",
      "PERF-261",
      "PERF-264",
    ],
    ownerPaths: ["electron/window/**", "src/store/**", "electron/services/**"],
  },
  {
    id: "JOURNEY-007",
    name: "Palette, file picker and switcher to selectable results",
    userQuestion: "After I start typing, when are the right results visible and safely selectable?",
    startBoundary: "the opening keystroke",
    usableEndBoundary:
      "the correct rows painted in the correct order with the intended row selectable by both keyboard and a real coordinate click",
    coverage: "gap",
    commands: [],
    coverageNote:
      "Ranking is measured well and nothing above it is. A ranker returning the right data cannot show that the row order painted, that Enter dispatched the intended action, or that an overlay did not eat the click (#12087).",
    linkedScenarios: [
      "PERF-170",
      "PERF-171",
      "PERF-190",
      "PERF-191",
      "PERF-192",
      "PERF-200",
      "PERF-204",
      "PERF-403",
      "PERF-404",
    ],
    ownerPaths: ["src/services/actions/**", "src/components/Sidebar/**", "src/hooks/**"],
  },
  {
    id: "JOURNEY-008",
    name: "Review Hub and file viewer to first useful content",
    userQuestion:
      "When I open a large review, how soon can I read the first diff and move through it without jank?",
    startBoundary: "the open action",
    usableEndBoundary:
      "the changed-file list painted, the first selected diff visible in the viewport, and the next-file action usable",
    coverage: "gap",
    commands: [],
    coverageNote:
      "PERF-160..163 and PERF-244..246 measure the data and tokenize path, and PERF-246 states outright that it is not first paint. PERF-163 does measure what tokenization costs the main thread, which is the jank half of this question below the renderer.",
    linkedScenarios: [
      "PERF-160",
      "PERF-161",
      "PERF-162",
      "PERF-163",
      "PERF-244",
      "PERF-245",
      "PERF-246",
    ],
    ownerPaths: ["src/components/Worktree/**", "src/panels/review/**", "src/panels/diff/**"],
  },
  {
    id: "JOURNEY-009",
    name: "Agent launch to prompt-ready",
    userQuestion: "After I start an agent, when is its terminal ready for a real prompt?",
    startBoundary: "the agent.launch dispatch the toolbar and tray buttons take",
    usableEndBoundary:
      "the panel and xterm are up, the agent's first output is rendered, focus is on it, and an input probe reaches the PTY",
    coverage: "partial",
    commands: ["agent-launch"],
    coverageNote:
      "Dispatch to panel, xterm and first output is measured against a deterministic fake CLI, which is the right hermetic choice. It stops at first output rather than at a prompt-ready marker plus a successful input probe.",
    linkedScenarios: ["PERF-200", "PERF-201", "PERF-350", "PERF-351", "PERF-352", "PERF-353"],
    ownerPaths: ["src/services/actions/**", "shared/config/agents/**", "electron/services/pty/**"],
  },
  {
    id: "JOURNEY-010",
    name: "Dev preview command to visible application",
    userQuestion: "After I run or switch a dev preview, when is the page visible and interactive?",
    startBoundary: "the dev-preview run action",
    usableEndBoundary:
      "the browser panel has navigated, the expected DOM content is painted, and one interaction probe succeeds",
    coverage: "gap",
    commands: [],
    coverageNote:
      "PERF-020..024 measure real detection, URL normalization and exit classification, and stop before navigation. Nothing continues to a painted page, so a detector that got faster while the panel showed nothing would read as an improvement.",
    linkedScenarios: ["PERF-020", "PERF-021", "PERF-022", "PERF-023", "PERF-024"],
    ownerPaths: ["src/panels/dev-preview/**", "src/panels/browser/**", "electron/services/**"],
  },
];

export function getJourney(id: string): JourneyDefinition | undefined {
  return JOURNEYS.find((journey) => journey.id === id.toUpperCase());
}
