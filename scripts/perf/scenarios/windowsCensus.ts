import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import type { PerfScenario, ScenarioSample } from "../types";
import {
  allSpawnMark,
  allSpawnsSince,
  installGitSpawnCounter,
  sleep,
  spawnObserverMisses,
} from "../lib/gitPipelineFixture";
import { createProcessTreeHarness, spawnProbeChild } from "../lib/idleFixture";

const execFileAsync = promisify(execFile);

/**
 * What the Windows process census costs per transport (PERF-409).
 *
 * Before #12243 every poll started a fresh `powershell.exe`, ran the WMI
 * enumeration, and exited — a process start plus a .NET runtime warm-up per
 * census, on a 1.5s-15s cadence for the life of the app. Only the enumeration
 * is inherent to the job. The shipped path now keeps one PowerShell warm and
 * writes it a request line instead.
 *
 * Both transports are measured in ONE window, at the real cadence, against the
 * same live process tree on the same machine in the same minute:
 *
 *   - the SUSTAINED arm is a real `ProcessTreeCache` with a real subscriber,
 *     which is what the product runs;
 *   - the BASELINE arm is the pre-#12243 transport reconstructed: one
 *     `execFile("powershell.exe", …)` per refresh, running `CENSUS_PIPELINE` —
 *     the SAME exported query string the shipped helper embeds, so the
 *     before/after compares two transports and not two different queries.
 *
 * So `baselineToSustainedLaunchRatio` is a measured before/after rather than
 * arithmetic over a remembered number.
 *
 * WHAT THE NUMBERS MEAN, AND WHAT THEY DO NOT.
 *
 * `censusLaunches` is exact and is the finding. It is a count, unaffected by
 * the arms sharing a window.
 *
 * `censusLatencyMs` and the CPU figures are read UNDER MUTUAL LOAD: the
 * baseline arm's forty PowerShell starts are real machine load that the
 * sustained arm pays for too. That biases both latency readings upward and is
 * the price of one window; the alternative — two windows — trades it for
 * thermal and background drift between them, which is worse for a reading this
 * short. Read them as a comparison, never as an absolute cost.
 *
 * `censusCpuMs` for the sustained arm is an OS reading, not self-reporting: the
 * helper is long-lived, so it appears in the BASELINE arm's own census payload,
 * and its `KernelModeTime`/`UserModeTime` are read straight out of there. The
 * baseline arm's own processes exit before anything could enumerate them, so
 * each one reports its own `TotalProcessorTime` before it returns. That sample
 * is taken before teardown, so the baseline arm is UNDERCOUNTED — the bias runs
 * against the finding, which is the safe direction.
 *
 * Neither CPU figure includes work done inside the WMI provider processes on
 * the other side of the CIM call. That work is real and is charged to
 * `WmiPrvSE.exe`, not to either arm.
 *
 * PLATFORMS. Windows only. There is no census transport to compare anywhere
 * else — macOS and Linux run one `ps`, which this change does not touch — so
 * the scenario is declared `unsupported` and skipped rather than reported as a
 * zero. That also means it never runs in this repo's Ubuntu-only push/PR CI:
 * it is reachable through a manual `perf-ab.yml` dispatch on a Windows runner,
 * or by hand on a Windows machine. The pure functions below carry the parsing,
 * percentile and oracle logic precisely so THAT much is covered by a unit suite
 * that does run everywhere.
 */

/** The pty-host's own `new ProcessTreeCache(1500)` cadence. */
export const CENSUS_POLL_INTERVAL_MS = 1_500;

/** Refreshes in a 60s window at that cadence: t = 0, 1500 … 58500. */
export const CENSUS_WINDOW_READS = 40;

/** The issue's bar: census CPU must at least halve. Reported, not enforced. */
export const CENSUS_REQUIRED_CPU_REDUCTION = 2;

/** Live children the fixture keeps in the tree for the oracle to find. */
const FIXTURE_CHILDREN = 3;

/** Long enough for a slow first CIM enumeration on a cold machine. */
const BASELINE_TIMEOUT_MS = 20_000;

/** An hour: far past the window, so the cache polls only when driven. */
const SELF_POLL_DISABLED_MS = 3_600_000;

/** Room for the refresh `start()` fires without awaiting. */
const SETTLE_MS = 250;

const BASELINE_CPU_PREFIX = "CPUMS:";

export interface CensusRow {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  KernelModeTime?: unknown;
  UserModeTime?: unknown;
}

/**
 * Nearest-rank percentile over a sample, in the sample's own units.
 *
 * Nearest-rank rather than interpolated: these are latencies of individual
 * refreshes, and an interpolated p95 reports a duration no refresh took.
 */
export function nearestRankPercentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Total CPU charged to `pid` in one census payload, in 100ns ticks. */
export function cpuTicksForPid(rows: readonly CensusRow[], pid: number): bigint | null {
  for (const row of rows) {
    if (Number(row?.ProcessId) !== pid) continue;
    try {
      return BigInt(String(row?.KernelModeTime ?? "0")) + BigInt(String(row?.UserModeTime ?? "0"));
    } catch {
      return null;
    }
  }
  return null;
}

/** 100ns ticks to milliseconds. */
export function ticksToMs(ticks: bigint): number {
  return Number(ticks) / 10_000;
}

/**
 * Split one baseline response into its census payload and the CPU the process
 * that produced it had consumed when it answered.
 */
export function parseBaselineResponse(stdout: string): { rows: CensusRow[]; cpuMs: number } {
  let cpuMs = 0;
  let payload = "";
  for (const rawLine of stdout.replace(/^\uFEFF/, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(BASELINE_CPU_PREFIX)) {
      cpuMs = Number(line.slice(BASELINE_CPU_PREFIX.length)) || 0;
      continue;
    }
    payload = line;
  }
  if (!payload || payload === "null") return { rows: [], cpuMs };
  const parsed: unknown = JSON.parse(payload);
  return { rows: Array.isArray(parsed) ? (parsed as CensusRow[]) : [parsed as CensusRow], cpuMs };
}

export interface FixtureExpectation {
  pid: number;
  ppid: number;
}

export interface OracleReading {
  /** Fixture children the snapshot did not contain. */
  fixtureDiscoveryMisses: number;
  /** Fixture children present but hanging off the wrong parent. */
  fixtureParentMisses: number;
}

/**
 * Grade one published snapshot against the fixture the harness actually
 * started.
 *
 * Without this the benchmark's best possible score is a dead census: a poller
 * that stopped starts nothing, costs nothing, and reports perfectly. Each
 * reading is a MISS COUNT, so a healthy pass is zero by construction.
 */
export function gradeSnapshot(
  lookup: (pid: number) => { ppid: number } | undefined,
  expected: readonly FixtureExpectation[]
): OracleReading {
  let fixtureDiscoveryMisses = 0;
  let fixtureParentMisses = 0;

  for (const child of expected) {
    const found = lookup(child.pid);
    if (!found) {
      fixtureDiscoveryMisses += 1;
      continue;
    }
    if (found.ppid !== child.ppid) fixtureParentMisses += 1;
  }

  return { fixtureDiscoveryMisses, fixtureParentMisses };
}

/**
 * Fixture children the census reported no CPU time against.
 *
 * Graded from the raw payload rather than the published snapshot: the cache
 * converts the tick counters into a delta percentage, which is 0 on a PID's
 * first sample by construction and so cannot distinguish "idle" from "the
 * counters are not being read at all".
 */
export function gradeCpuTicks(
  rows: readonly CensusRow[],
  expected: readonly FixtureExpectation[]
): number {
  let misses = 0;
  for (const child of expected) {
    const ticks = cpuTicksForPid(rows, child.pid);
    if (ticks === null || ticks <= 0n) misses += 1;
  }
  return misses;
}

/**
 * Apparatus-integrity predicates only.
 *
 * The issue's "census CPU must at least halve" bar is deliberately NOT here.
 * It is the judgement this scenario exists to inform, and a reading taken on
 * the parent commit — where the sustained arm IS the baseline transport and
 * the ratio is 1 — has to stay valid evidence rather than a failed run.
 */
const CORRECTNESS = [
  "spawnObserverMisses",
  "censusLivenessMisses",
  "helperReuseMisses",
  "baselineFidelityMisses",
  "fixtureDiscoveryMisses",
  "fixtureParentMisses",
  "fixtureCpuMisses",
] as const;

function failClosed(reason: string, metrics: Record<string, number>): ScenarioSample {
  return {
    durationMs: 0,
    metrics: {
      censusLaunches: 0,
      baselineCensusLaunches: 0,
      baselineToSustainedLaunchRatio: 0,
      censusCpuMs: 0,
      baselineCensusCpuMs: 0,
      censusLatencyMsP95: 0,
      baselineCensusLatencyMsP95: 0,
      helperRssKb: 0,
      censusRefreshes: 0,
      baselineRefreshes: 0,
      windowMs: 0,
      censusLivenessMisses: 1,
      helperReuseMisses: 1,
      baselineFidelityMisses: 1,
      fixtureDiscoveryMisses: 1,
      fixtureParentMisses: 1,
      fixtureCpuMisses: 1,
      ...metrics,
    },
    notes: `apparatus failed closed: ${reason}`,
  };
}

/** Starts in a window whose executable is the census's own PowerShell. */
function powerShellStarts(window: { byExecutable: Record<string, number> }): number {
  let total = 0;
  for (const [executable, count] of Object.entries(window.byExecutable)) {
    if (executable === "powershell.exe" || executable === "pwsh.exe") total += count;
  }
  return total;
}

export const windowsCensusScenarios: PerfScenario[] = [
  {
    id: "PERF-409",
    name: "Windows Process Census Transport",
    description:
      "A real ProcessTreeCache driven at the pty-host's own 1500ms cadence for the 40 refreshes a minute contains, on a tree holding live fixture children, counting the `powershell.exe` starts the census actually makes. Two arms share the window: the shipped persistent helper, and the pre-#12243 transport reconstructed as one `execFile` per refresh over the SAME exported census query. The ratio between them is a measured before/after on one machine in one session. CPU is an OS reading for the persistent arm — it is long-lived, so it appears in the other arm's own census payload — and a pre-teardown self-report for the one-shot arm, which undercounts it in the direction that works against the finding. Latency and CPU are read under mutual load and are a comparison, not an absolute cost. The predicates grade the apparatus, not the verdict: the spawn observer must prove it can still see a start, the cache must have produced healthy snapshots, the persistent arm must genuinely have reused one process, the reference arm must achieve its one-start-per-refresh workload, and every live fixture child must be discovered under the right parent with CPU time against it — because a census that died starts nothing and would otherwise post the best number in the suite. The issue's halving bar is reported and deliberately left out of the predicates, so a reading taken on the parent commit stays valid evidence. Windows only: no other platform has this transport.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    // One 60s window per iteration, and the reading is a rate over that window:
    // a warmup would double the wall clock to sharpen a figure that is not
    // timing-sensitive.
    warmups: 0,
    iterations: { ci: 1, nightly: 1 },
    correctness: [...CORRECTNESS],
    platforms: { linux: "unsupported", darwin: "unsupported", win32: "supported" },
    async run(): Promise<ScenarioSample> {
      // Lazily imported inside run(): `scenarios/index.ts` loads every scenario
      // module eagerly, and a module-scope import of electron-side code puts it
      // in every perf process whichever id was asked for — the shape that
      // silently killed thirteen scenarios once already.
      const { CENSUS_PIPELINE } = await import("../../../electron/services/WindowsProcessCensus");

      // The reconstructed pre-#12243 transport. Same query, same encoding
      // bootstrap, one process per refresh — plus a CPU self-report, which is
      // the only way to read a process that has already exited.
      const baselineScript =
        "$ErrorActionPreference = 'SilentlyContinue'; " +
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
        "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
        "$payload = " +
        CENSUS_PIPELINE +
        "; " +
        "if ($null -eq $payload) { $payload = '[]' } " +
        "[Console]::Out.WriteLine($payload); " +
        "[Console]::Out.WriteLine('" +
        BASELINE_CPU_PREFIX +
        "' + [System.Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalMilliseconds)";

      installGitSpawnCounter();
      // Before any measurement window: the observer's self-validation starts a
      // child of its own, which would otherwise land in the count it validates.
      const observerMisses = spawnObserverMisses();

      // Opened BEFORE the harness: the cold helper launch is part of what the
      // persistent transport costs, and a window opened after it would hide the
      // one start the whole comparison turns on.
      const windowMark = allSpawnMark();

      // The cache is driven explicitly below rather than left to self-poll:
      // this scenario measures the cost of ONE census, and a self-scheduling
      // poller racing the driver would mix its own refreshes into the latency
      // sample and leave the count of refreshes to the scheduler. The idle
      // cadence itself is PERF-092's subject, not this one's.
      const harness = await createProcessTreeHarness(SELF_POLL_DISABLED_MS);
      const children = Array.from({ length: FIXTURE_CHILDREN }, () => spawnProbeChild());
      const expected: FixtureExpectation[] = children
        .map((child) => child.pid)
        .filter((pid): pid is number => pid !== null)
        .map((pid) => ({ pid, ppid: process.pid }));

      try {
        if (expected.length !== FIXTURE_CHILDREN) {
          return failClosed(
            `only ${expected.length} of ${FIXTURE_CHILDREN} fixture children started`,
            { spawnObserverMisses: observerMisses }
          );
        }

        // `start()` fires a refresh it does not await. Let it settle so the
        // first timed refresh below is not swallowed by the `isRefreshing`
        // guard and recorded as a zero-latency sample.
        await sleep(SETTLE_MS);

        const start = performance.now();

        let censusRefreshes = 0;
        let baselineRefreshes = 0;
        let baselineLaunches = 0;
        let baselineCpuMs = 0;
        const censusLatencies: number[] = [];
        const baselineLatencies: number[] = [];
        const oracle: OracleReading = { fixtureDiscoveryMisses: 0, fixtureParentMisses: 0 };
        let fixtureCpuMisses = 0;
        let helperFirstTicks: bigint | null = null;
        let helperLastTicks: bigint | null = null;
        let helperRssKb = 0;

        for (let read = 0; read < CENSUS_WINDOW_READS; read += 1) {
          const deadline = start + read * CENSUS_POLL_INTERVAL_MS;
          const waitMs = deadline - performance.now();
          if (waitMs > 0) await sleep(waitMs);

          // The sustained arm: the shipped cache's own refresh, timed from
          // request to published snapshot, which is the freshness the issue
          // asks about.
          const censusStart = performance.now();
          const before = harness.refreshCount();
          await harness.cache.refresh();
          const censusLatency = performance.now() - censusStart;
          if (harness.refreshCount() > before) {
            censusRefreshes += 1;
            censusLatencies.push(censusLatency);
          }

          // Graded on EVERY refresh, not once at the end: a census that goes
          // blind halfway through would otherwise pass on its first snapshot.
          const reading = gradeSnapshot((pid) => {
            const proc = harness.cache.getProcess(pid);
            return proc ? { ppid: proc.ppid } : undefined;
          }, expected);
          oracle.fixtureDiscoveryMisses += reading.fixtureDiscoveryMisses;
          oracle.fixtureParentMisses += reading.fixtureParentMisses;

          const helperPid = harness.cache.getCensusHelperPid();
          helperRssKb = Math.max(helperRssKb, harness.cache.getCensusHelperRssKb() ?? 0);

          // The reference arm: one fresh PowerShell per refresh, which is what
          // every poll cost before #12243.
          const baselineMark = allSpawnMark();
          const baselineStart = performance.now();
          let rows: CensusRow[] = [];
          try {
            const { stdout } = await execFileAsync(
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", baselineScript],
              {
                timeout: BASELINE_TIMEOUT_MS,
                maxBuffer: 32 * 1024 * 1024,
                windowsHide: true,
                encoding: "utf8",
              }
            );
            const parsed = parseBaselineResponse(stdout);
            rows = parsed.rows;
            baselineCpuMs += parsed.cpuMs;
            baselineRefreshes += 1;
            baselineLatencies.push(performance.now() - baselineStart);
          } catch {
            // A failed reference refresh still counts its start below; it just
            // contributes no rows, and `baselineFidelityMisses` reports the gap.
          }
          baselineLaunches += powerShellStarts(allSpawnsSince(baselineMark));

          // Raw CPU ticks for the fixture children, and for the persistent
          // helper, out of the payload that enumerated the whole machine.
          if (rows.length > 0) {
            fixtureCpuMisses += gradeCpuTicks(rows, expected);
            if (helperPid !== null) {
              const ticks = cpuTicksForPid(rows, helperPid);
              if (ticks !== null) {
                helperFirstTicks ??= ticks;
                helperLastTicks = ticks;
              }
            }
          }
        }

        const windowMs = performance.now() - start;
        const censusLaunches = powerShellStarts(allSpawnsSince(windowMark)) - baselineLaunches;
        const censusCpuMs =
          helperFirstTicks !== null && helperLastTicks !== null
            ? ticksToMs(helperLastTicks - helperFirstTicks)
            : 0;

        // The persistent arm really did reuse ONE process. Without this, an
        // arm that respawned on every refresh and an arm that never ran at all
        // are both "a low number".
        const helperReuseMisses = censusRefreshes > 1 && censusLaunches <= 1 ? 0 : 1;
        const baselineFidelityMisses = baselineLaunches === CENSUS_WINDOW_READS ? 0 : 1;
        const censusLivenessMisses = harness.isHealthy() && censusRefreshes > 0 ? 0 : 1;

        const metrics: Record<string, number> = {
          spawnObserverMisses: observerMisses,
          censusLivenessMisses,
          helperReuseMisses,
          baselineFidelityMisses,
          ...oracle,
          fixtureCpuMisses,
          censusLaunches,
          baselineCensusLaunches: baselineLaunches,
          baselineToSustainedLaunchRatio:
            censusLaunches > 0 ? baselineLaunches / censusLaunches : baselineLaunches,
          censusCpuMs,
          baselineCensusCpuMs: baselineCpuMs,
          baselineToSustainedCpuRatio: censusCpuMs > 0 ? baselineCpuMs / censusCpuMs : 0,
          censusLatencyMsP95: nearestRankPercentile(censusLatencies, 0.95),
          baselineCensusLatencyMsP95: nearestRankPercentile(baselineLatencies, 0.95),
          helperRssKb,
          censusRefreshes,
          baselineRefreshes,
          windowMs,
        };

        return {
          // Self-timed against nothing: the reading is a count and a CPU total
          // over a fixed 60s window, and 60s of deliberate waiting is not a
          // duration anything should compare.
          durationMs: 0,
          metrics,
          notes:
            `${censusLaunches} PowerShell start(s) against a ${baselineLaunches}-start reference ` +
            `over ${CENSUS_WINDOW_READS} refreshes; census CPU ${censusCpuMs.toFixed(0)}ms against ` +
            `${baselineCpuMs.toFixed(0)}ms (the issue's bar is ${CENSUS_REQUIRED_CPU_REDUCTION}x)`,
        };
      } finally {
        harness.stop();
        for (const child of children) child.kill();
      }
    },
  },
];
