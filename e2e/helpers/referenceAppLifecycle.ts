/**
 * The reference-app lifecycle matrix (#14116): what the Request Desk reference
 * application must survive, and where each row is proven. A row is covered by a
 * named test in the explicitly invoked correctness spec, measured by the
 * report-only benchmark, or recorded as a gap with the reason and the coverage
 * that does exist elsewhere. `__tests__/referenceAppLifecycle.test.ts` keeps
 * this table, both specs and the doc from drifting apart.
 */

export const REFERENCE_APP_ID = "acme.requests";
export const REFERENCE_APP_SOURCE = "plugins/sample-project/acme.requests";

export const LIFECYCLE_SPEC = "e2e/plugins/reference-app-lifecycle.spec.ts";
export const LIFECYCLE_PERF_SPEC = "e2e/perf/reference-app-lifecycle-perf.spec.ts";
export const LIFECYCLE_PERF_COMMAND = "reference-app-lifecycle";
export const LIFECYCLE_DOC = "docs/plugins/reference-app-lifecycle.md";

/**
 * Six independently scoped projects against a two-view renderer cache. Six is
 * above the largest cache any machine gets by default, so whatever the cap,
 * a full rotation evicts. Names share no prefix: the switcher matches on a
 * substring of the folder name.
 */
export const LIFECYCLE_WORKLOAD = {
  projects: ["desk-alpha", "desk-bravo", "desk-charlie", "desk-delta", "desk-echo", "desk-foxtrot"],
  cachedViewLimit: 2,
  rotations: 2,
  /** Requests added to each project on top of the three seeded ones (perf only). */
  perfExtraRequests: 100,
  perfWarmSamples: 10,
  perfColdSamples: 10,
  perfIdleWindowMs: 15_000,
} as const;

export type LifecycleCoverage =
  | { kind: "test"; title: string }
  | { kind: "perf"; metric: string }
  | { kind: "gap"; reason: string; elsewhere?: string[] };

export interface LifecycleRow {
  id: string;
  criterion: string;
  coverage: LifecycleCoverage[];
}

export const LIFECYCLE_MATRIX: readonly LifecycleRow[] = [
  {
    id: "fresh-open",
    criterion: "A fresh project holds the app dark until trusted, then activates it",
    coverage: [{ kind: "test", title: "a fresh project runs the app only once it is trusted" }],
  },
  {
    id: "welcome-setup",
    criterion: "Setup and the welcome decision are per project and observed by the host",
    coverage: [
      { kind: "test", title: "setup and the welcome answer are recorded for this project only" },
    ],
  },
  {
    id: "agent-tools",
    criterion: "An agent launched in the project gets the app's tools and runs a first operation",
    coverage: [
      {
        kind: "test",
        title: "an agent launched in the project reaches the app's tools and builds a report",
      },
    ],
  },
  {
    id: "rotation-isolation",
    criterion:
      "Repeated switching among more projects than the cache holds keeps each project's data and settings its own",
    coverage: [
      {
        kind: "test",
        title: "six projects keep their own data through rotations past a two-view cache",
      },
    ],
  },
  {
    id: "credential-isolation",
    criterion: "One project's agent credential is refused by another project's endpoint",
    coverage: [
      { kind: "test", title: "one project's agent credential is refused by another project" },
    ],
  },
  {
    id: "draft-eviction",
    criterion:
      "An unsaved draft and the selected request survive LRU pressure, forced reclaim and a compatible reload",
    coverage: [
      {
        kind: "test",
        title: "a draft and its request survive cache pressure, reclaim and a plugin reload",
      },
    ],
  },
  {
    id: "system-sleep",
    criterion: "System suspend and resume leave the app usable",
    coverage: [
      { kind: "test", title: "the app answers after a simulated system suspend and resume" },
      {
        kind: "gap",
        reason:
          "Only powerMonitor's suspend/resume events are emitted. Real OS sleep (frozen timers, dropped sockets, Chromium throttling) cannot be automated.",
      },
    ],
  },
  {
    id: "restart",
    criterion:
      "Trust, setup, welcome, navigation, draft and an in-flight operation survive a restart",
    coverage: [
      {
        kind: "test",
        title: "a restart keeps trust, setup, the draft and the report started before it",
      },
    ],
  },
  {
    id: "tour-background",
    criterion: "No tour or media plays for a project that is not presented",
    coverage: [
      {
        kind: "gap",
        reason:
          "Request Desk's tour is silent (audioUrl: null) and the pause is driven by renderer presentation signals, not by anything a plugin can observe.",
        elsewhere: ["src/components/Tour/__tests__/TourDialog.test.tsx"],
      },
    ],
  },
  {
    id: "switch-timings",
    criterion: "Warm and cold switch timings for the reference workload",
    coverage: [
      { kind: "perf", metric: "switch.warm" },
      { kind: "perf", metric: "switch.cold" },
    ],
  },
  {
    id: "resources",
    criterion: "Memory and idle/background CPU with exact workload and hardware",
    coverage: [
      { kind: "perf", metric: "memory" },
      { kind: "perf", metric: "cpu.idle" },
      { kind: "perf", metric: "cpu.active" },
    ],
  },
  {
    id: "multi-window",
    criterion: "Multiple windows",
    coverage: [
      {
        kind: "gap",
        reason:
          "Not exercised with the reference app. Per-window project identity is covered by the host's own multi-window spec.",
        elsewhere: ["e2e/full/platform/core-multi-window.spec.ts"],
      },
    ],
  },
  {
    id: "large-records",
    criterion: "Representative large virtualized records and artifacts",
    coverage: [
      {
        kind: "gap",
        reason:
          "Request Desk's Home lists at most 100 rows without virtualization and its report artifact is a small SVG. The perf run seeds 100 extra requests per project; virtualized-list cost is measured on the host's own list.",
        elsewhere: ["e2e/full/resilience/core-perf-list-mount-budget.spec.ts"],
      },
    ],
  },
  {
    id: "remote-reconnect",
    criterion: "Remote disconnect and reconnect",
    coverage: [
      {
        kind: "gap",
        reason:
          "Needs the private sshd harness and its own config. Plugin MCP behaviour across a dropped link and transport reconnect are covered there.",
        elsewhere: [
          "e2e/remote-hosts/remote-host-plugins-mcp.spec.ts",
          "e2e/remote-hosts/remote-host-ssh.spec.ts",
        ],
      },
    ],
  },
];
