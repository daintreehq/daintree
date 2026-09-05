import type { BenchmarkClass, BenchmarkFidelity, BenchmarkKind } from "../types";

/**
 * What each scenario's numbers are allowed to be claimed to mean.
 *
 * The failure this exists to stop is not a wrong number. It is a correct number
 * carrying a claim it cannot support: "production code ran" read as "the user
 * received a correct, usable result". Most of this matrix ends at a service
 * return, a store update, or a parser completing, with the renderer, Chromium
 * scheduling, Electron transport, compositor and focus state deliberately
 * absent. That is the right design for attribution — it is the wrong thing to
 * quote in a sentence beginning "Daintree got faster for users".
 *
 * So every scenario declares a class:
 *
 *   `journey`    real user entry point, production process topology, ending at
 *                a correct visible or usable result.
 *   `mechanism`  real shipped function or service with an independent oracle,
 *                and one or more user-path layers removed on purpose.
 *   `diagnostic` the subject inside the timed bracket is emulated, shimmed,
 *                simulated or a deliberate floor. A signal, not a measurement.
 *
 * `fidelity` states which layers are present rather than scoring quality. It is
 * a description, not a grade: a `mechanism` benchmark with `renderer: "absent"`
 * is working exactly as intended.
 *
 * Classification lives here rather than on each `PerfScenario` for one reason:
 * the whole table is readable at once. Fidelity claims are only auditable side
 * by side — "why is this family `mechanism` when that one is `diagnostic`" is
 * unanswerable when the two declarations are 4,000 lines apart in different
 * files. `__tests__/benchmarkClasses.test.ts` enforces exact coverage of
 * `EXPECTED_SCENARIO_IDS` in both directions, so a new scenario cannot skip it.
 */

interface Family {
  /** Short label, printed in reports beside the class. */
  label: string;
  ids: readonly string[];
  kind: BenchmarkKind;
  fidelity: BenchmarkFidelity;
  /** What may be claimed from these numbers, and what is deliberately absent. */
  claim: string;
}

/** In-process, no renderer, no child processes, nothing over a wire. */
const PURE: BenchmarkFidelity = {
  entryPoint: "internal-function",
  renderer: "absent",
  electronTransport: "none",
  pty: "none",
  processTopology: "single-process",
  externalDependencies: "hermetic",
};

function withFidelity(overrides: Partial<BenchmarkFidelity>): BenchmarkFidelity {
  return { ...PURE, ...overrides };
}

const FAMILIES: readonly Family[] = [
  {
    label: "startup hydration",
    ids: ["PERF-001", "PERF-002", "PERF-003"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Hydration and warm-start work through the real builders. No window, no renderer, no paint — a faster number here does not by itself mean the user can type sooner.",
  },
  {
    label: "packaged launch",
    ids: ["PERF-004"],
    kind: "journey",
    fidelity: withFidelity({
      entryPoint: "user-event",
      renderer: "real",
      electronTransport: "real",
      processTopology: "packaged",
    }),
    claim:
      "A real packaged app launched the way a user launches it, measured to the app's own boot marks. It ends at app readiness, NOT at a focused terminal that accepts a keystroke.",
  },
  {
    label: "hydration + project/worktree switch state",
    ids: ["PERF-010", "PERF-011", "PERF-012", "PERF-013"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real layout merge, scope and switch state. Ends when the state is correct; no view swap, no React commit, no frame.",
  },
  {
    label: "dev preview detection",
    ids: ["PERF-020", "PERF-021", "PERF-022", "PERF-023", "PERF-024"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "The real URL detector, normalizer and exit classifier over recorded output. Stops before browser-panel navigation and page paint, so it cannot say when the preview became visible.",
  },
  {
    label: "terminal output pipeline",
    ids: ["PERF-030", "PERF-031", "PERF-032"],
    kind: "mechanism",
    fidelity: withFidelity({ renderer: "headless", pty: "fake" }),
    claim:
      "Real ingest, chunking and retention against a fake IPty and a headless terminal. No Chromium scheduling and no paint: this is parse-side cost, not perceived latency.",
  },
  {
    label: "xterm write-to-parse",
    ids: ["PERF-033", "PERF-034"],
    kind: "mechanism",
    fidelity: withFidelity({ renderer: "headless", pty: "fake" }),
    claim:
      "A real @xterm/headless parser and buffer. PERF-034's echo isolation is a parse-level bracket — the frame the user waits for is measured by the `interactivity` journey, not here.",
  },
  {
    label: "agent output analysis",
    ids: ["PERF-035"],
    kind: "diagnostic",
    fidelity: PURE,
    claim:
      "The real detection FSM driven under a substituted virtual clock, so the flip latencies are simulated time rather than observed time. CPU-per-MB is a real reading; the latencies are a signal.",
  },
  {
    label: "utility host IPC",
    ids: ["PERF-042", "PERF-043", "PERF-044", "PERF-045", "PERF-046"],
    kind: "mechanism",
    fidelity: withFidelity({
      entryPoint: "public-api",
      electronTransport: "node-channel",
      processTopology: "partial",
    }),
    claim:
      "Real utility hosts and real structured clone, over a Node child channel rather than Electron's own transport. Close to the shipped shape, and not the renderer round trip a user waits on.",
  },
  {
    label: "persistence",
    ids: ["PERF-053", "PERF-054", "PERF-055", "PERF-056", "PERF-057", "PERF-058"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real better-sqlite3 and real electron-store writes, including WAL and whole-file amplification. Nothing here says how much of a save or an open the user perceives.",
  },
  {
    label: "soak",
    ids: ["PERF-060", "PERF-061", "PERF-062", "PERF-063"],
    kind: "mechanism",
    fidelity: withFidelity({ renderer: "headless", pty: "fake" }),
    claim:
      "Long-run allocation and activity behaviour. Retained memory is measured; interaction latency across the soak is not, so 'memory is stable' does not imply 'the app still feels the same'.",
  },
  {
    label: "project switch phases",
    ids: ["PERF-070", "PERF-071", "PERF-072", "PERF-073"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real serialize/restore phase costs for a switch. Phase attribution only — no view, no paint, no input readiness.",
  },
  {
    label: "project view lifecycle",
    ids: ["PERF-074", "PERF-075", "PERF-076", "PERF-077"],
    kind: "diagnostic",
    fidelity: withFidelity({ electronTransport: "stubbed" }),
    claim:
      "Real ProjectViewManager control flow against inert Electron and Chromium stand-ins. The structural counts (creates, reactivations, evictions) are trustworthy; the DURATIONS are not a switch latency — no navigation, GPU work, paint or real renderer failure happens inside the bracket. Use the `project-switch` journey for latency.",
  },
  {
    label: "migration chain",
    ids: ["PERF-080"],
    kind: "mechanism",
    fidelity: withFidelity({ processTopology: "partial" }),
    claim: "The real MigrationRunner over a real database. Startup impact is not measured here.",
  },
  {
    label: "idle service tax",
    ids: ["PERF-092", "PERF-093", "PERF-094"],
    kind: "mechanism",
    fidelity: withFidelity({ processTopology: "partial" }),
    claim:
      "Real process-tree and worktree monitors idling, with real child processes. In-process CPU only — not the packaged app's idle tax across renderer, GPU and utility processes.",
  },
  {
    label: "git pipeline",
    ids: ["PERF-100", "PERF-101", "PERF-102", "PERF-103", "PERF-104", "PERF-105", "PERF-106"],
    kind: "mechanism",
    fidelity: withFidelity({ processTopology: "partial" }),
    claim:
      "Real git status, watchers, polling and quiescence against real repositories, with real git subprocesses. Backend detection is measured; whether the sidebar visibly updated is not. Spawn tallies count Node child starts only (see README).",
  },
  {
    label: "terminal reflow and resize",
    ids: ["PERF-110", "PERF-111", "PERF-112"],
    kind: "mechanism",
    fidelity: withFidelity({ renderer: "headless" }),
    claim:
      "Real xterm history, reflow and the reveal lockup guard. Final visual geometry after a background resize is NOT asserted — that is the #11900 shape, and it needs rendered cell geometry.",
  },
  {
    label: "sidebar watcher to store",
    ids: [
      "PERF-130",
      "PERF-131",
      "PERF-132",
      "PERF-133",
      "PERF-134",
      "PERF-135",
      "PERF-136",
      "PERF-137",
      "PERF-138",
      "PERF-139",
      "PERF-140",
      "PERF-141",
      "PERF-142",
    ],
    kind: "mechanism",
    fidelity: withFidelity({ processTopology: "partial" }),
    claim:
      "Real watchers, real git topology and the real store apply path, ending at store emission. A store emission is not a rendered card: virtualization, React commit and paint are outside the bracket.",
  },
  {
    label: "fleet broadcast",
    ids: ["PERF-150", "PERF-151"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real eligibility, substitution and fan-out through the broker. No terminal reaches a usable state inside the bracket, and no foreground cost is measured.",
  },
  {
    label: "diff tokenization",
    ids: ["PERF-160", "PERF-161", "PERF-162", "PERF-163"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "The real tokenizer and its oversized fallback. PERF-163 additionally measures how long the main thread was unavailable while it ran, against an idle calibration window — main-thread availability, not painted latency.",
  },
  {
    label: "action palette ranking",
    ids: ["PERF-170", "PERF-171"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real ranking over the real catalog, per keystroke. Says nothing about how many rows React re-rendered or whether the list stayed usable.",
  },
  {
    label: "file picker",
    ids: ["PERF-190", "PERF-191", "PERF-192"],
    kind: "mechanism",
    fidelity: withFidelity({ processTopology: "partial" }),
    claim:
      "The real file-search service and real git path listing, warm and cold. Ends at ranked results, not at a painted, selectable list.",
  },
  {
    label: "terminal search",
    ids: ["PERF-193", "PERF-194"],
    kind: "mechanism",
    fidelity: withFidelity({ renderer: "headless" }),
    claim:
      "The real xterm search addon over a real buffer, including marker lifecycle. Highlights are never painted, so an invisible or mis-positioned highlight passes.",
  },
  {
    label: "session snapshot capture",
    ids: ["PERF-195"],
    kind: "mechanism",
    fidelity: withFidelity({ renderer: "headless" }),
    claim:
      "Real SerializeAddon output across a real headless fleet — the teardown cost paid on every quit. Capture only: nothing here says what the payload costs to read back, and no disk write is in the bracket.",
  },
  {
    label: "session restore parser floor",
    ids: ["PERF-196"],
    kind: "diagnostic",
    fidelity: withFidelity({ renderer: "headless" }),
    claim:
      "A deliberate FLOOR: the raw parser cost of reparsing fleet scrollback, with TerminalRestoreController's production chunking, yielding and fleet scheduling omitted. Real restore is slower by construction; never quote this as restore latency.",
  },
  {
    label: "action dispatch",
    ids: ["PERF-200", "PERF-201", "PERF-202", "PERF-203", "PERF-204", "PERF-205"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real catalog, gate chain, schema generation and keybinding resolution. Action BODIES and the UI they produce are outside the bracket.",
  },
  {
    label: "plugin host",
    ids: ["PERF-220", "PERF-221", "PERF-222", "PERF-223", "PERF-224", "PERF-225"],
    kind: "mechanism",
    fidelity: withFidelity({
      electronTransport: "node-channel",
      processTopology: "partial",
    }),
    claim:
      "Real plugin workers, manifests, capability gates and boundary round trips over a Node child channel. The product supervisor and full app readiness are only partly represented.",
  },
  {
    label: "file browser",
    ids: ["PERF-240", "PERF-241", "PERF-242", "PERF-243"],
    kind: "mechanism",
    fidelity: withFidelity({ processTopology: "partial" }),
    claim:
      "Real tree build, filters, refresh sweep and expansion over real repositories. PERF-242 performs the refresh a change triggers but cannot prove the React hook fired or that a row was painted.",
  },
  {
    label: "review hub",
    ids: ["PERF-244", "PERF-245"],
    kind: "mechanism",
    fidelity: withFidelity({ processTopology: "partial" }),
    claim:
      "The real changed-file data path and its cache. No first useful paint and no complete-list paint.",
  },
  {
    label: "file viewer",
    ids: ["PERF-246"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real language resolution and parsing for a large file. Explicitly NOT first paint — the highlighted viewport a user waits for is not measured.",
  },
  {
    label: "supervision and recovery",
    ids: ["PERF-260", "PERF-261", "PERF-262", "PERF-263", "PERF-264"],
    kind: "mechanism",
    fidelity: withFidelity({
      electronTransport: "node-channel",
      processTopology: "partial",
    }),
    claim:
      "Real restart ladders, replay policy and crash classification with real child processes. Ends at policy and replay; the user-visible recovered terminal is not reached.",
  },
  {
    label: "MCP server",
    ids: ["PERF-280", "PERF-281", "PERF-282", "PERF-283", "PERF-284", "PERF-285"],
    kind: "mechanism",
    fidelity: withFidelity({
      entryPoint: "public-api",
      electronTransport: "node-channel",
      processTopology: "partial",
    }),
    claim:
      "The real SDK, session, auth tiers and dedup over a real transport. A tool call ends at its result, not at the terminal or panel an external agent asked for.",
  },
  {
    label: "theme",
    ids: ["PERF-300", "PERF-301", "PERF-302", "PERF-303", "PERF-304", "PERF-305"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real palette resolution, contrast/APCA sweeps and colour maths. No theme-switch frame, so a 'fast' switch that leaves stale colours on screen passes.",
  },
  {
    label: "notifications",
    ids: ["PERF-320", "PERF-321", "PERF-322", "PERF-323", "PERF-324", "PERF-325"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real routing, suppression and dedup decisions. No OS delivery and no painted badge or window title.",
  },
  {
    label: "forge registry",
    ids: ["PERF-340", "PERF-341", "PERF-342", "PERF-343"],
    kind: "mechanism",
    fidelity: withFidelity({ electronTransport: "node-channel" }),
    claim:
      "Real registry, resolution, singleflight and relay push against a hermetic fixture — no network. Ends at the resolver, not at a ready issue or PR surface.",
  },
  {
    label: "agent roster",
    ids: ["PERF-350", "PERF-351", "PERF-352", "PERF-353"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real roster merge, pattern compilation and launch-command assembly. Nothing launches; prompt-ready is not reached.",
  },
  {
    label: "IPC envelope",
    ids: ["PERF-360", "PERF-361", "PERF-362", "PERF-363", "PERF-364"],
    kind: "mechanism",
    fidelity: withFidelity({ entryPoint: "public-api", electronTransport: "stubbed" }),
    claim:
      "The real validation and serialization wrapper. Electron's own structured clone, pipe and renderer return are OUTSIDE the bracket, so this is wrapper cost and not the IPC latency a user waits on.",
  },
  {
    label: "PTY flow control",
    ids: ["PERF-370", "PERF-371", "PERF-372", "PERF-373"],
    kind: "mechanism",
    fidelity: withFidelity({ pty: "fake", electronTransport: "node-channel" }),
    claim:
      "Real pause/resume decisions and aggregate sweeps. Decision cost is not output-delivery latency: flow control that protects memory by making terminals laggy scores well here.",
  },
  {
    label: "logging",
    ids: ["PERF-380", "PERF-381", "PERF-382", "PERF-383", "PERF-384"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "The real scrubber, serializer, batcher and rotation at the real boundary. Renderer broadcast and whole-app main-thread contention are absent.",
  },
  {
    label: "CopyTree",
    ids: ["PERF-390", "PERF-391", "PERF-392", "PERF-395"],
    kind: "mechanism",
    fidelity: withFidelity({ processTopology: "partial" }),
    claim:
      "Real context generation, worker offload and temp-file streaming. No menu invocation and no artifact-ready endpoint. PERF-395 adds the foreground cost — main-thread availability while generation runs, which is not keystroke-to-paint.",
  },
  {
    label: "CLI availability",
    ids: ["PERF-393", "PERF-394"],
    kind: "mechanism",
    fidelity: withFidelity({ processTopology: "partial" }),
    claim:
      "Real refresh logic and real probe arithmetic. Login-shell cost is only partly represented, and the wizard states a first-run user sees are not. Diagnostic on Windows, where the spawn observer is blind (see `platforms`).",
  },
  {
    label: "sidebar derivation",
    ids: ["PERF-400", "PERF-401", "PERF-402"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real pure derivations with independent ordering oracles. React commit, virtualization and interaction are outside the bracket — correct data is not a rendered row (#12094).",
  },
  {
    label: "project switcher search",
    ids: ["PERF-403", "PERF-404"],
    kind: "mechanism",
    fidelity: PURE,
    claim:
      "Real ranking and one-edit correction over the real project list. No painted list, no selection, no dispatched action.",
  },
  {
    label: "image-path probe",
    ids: ["PERF-405"],
    kind: "mechanism",
    fidelity: withFidelity({ entryPoint: "public-api", processTopology: "partial" }),
    claim:
      "The real probe making real OS lookups at the pty-host's own poll cadence, with both the current and the pre-backoff read rule measured in the same window. It is how often a permanently failing PID starts a subprocess, NOT what one probe costs against a live process — an absent PID is cheaper for `lsof` to answer — and not the detector latency a user would notice. Skipped on Linux, where the probe is a bare readlink and starts nothing; diagnostic on Windows, where PowerShell start cost dominates the reading.",
  },
  {
    label: "terminal submit lane",
    ids: ["PERF-036"],
    kind: "mechanism",
    fidelity: withFidelity({ entryPoint: "public-api", pty: "fake" }),
    claim:
      "The real WriteQueue serialising real submits against a recording PTY sink, graded on the exact byte tape and on the lane's own concurrency. Body/Enter ordering is authoritative; the composer the bytes land in is not rendered. Only the nightly arm crosses the shipped slow-submit threshold — the fast arms cover the defect class, not the literal constant.",
  },
];

const BY_ID = new Map<string, BenchmarkClass>();
for (const family of FAMILIES) {
  for (const id of family.ids) {
    if (BY_ID.has(id)) {
      throw new Error(`Benchmark class declared twice for ${id} (family "${family.label}")`);
    }
    BY_ID.set(id, {
      kind: family.kind,
      family: family.label,
      fidelity: family.fidelity,
      claim: family.claim,
    });
  }
}

/** Every id this table classifies. Read by the coverage test in both directions. */
export const CLASSIFIED_SCENARIO_IDS: ReadonlySet<string> = new Set(BY_ID.keys());

/**
 * The class for one scenario, or undefined when it has none.
 *
 * Deliberately not defaulted to `mechanism`: a silent default is how every new
 * scenario ends up carrying the most flattering classification available
 * without anyone deciding it should. The test refuses an unclassified id.
 */
export function classifyBenchmark(scenarioId: string): BenchmarkClass | undefined {
  return BY_ID.get(scenarioId);
}

/** One-line rendering for a report row. */
export function describeBenchmarkClass(cls: BenchmarkClass): string {
  const f = cls.fidelity;
  return (
    `${cls.kind} (${cls.family}) — entry ${f.entryPoint}, renderer ${f.renderer}, ` +
    `transport ${f.electronTransport}, pty ${f.pty}, topology ${f.processTopology}, ` +
    `deps ${f.externalDependencies}`
  );
}
