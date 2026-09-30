/**
 * Sibling-worktree background fetch benchmark. Skipped unless DAINTREE_BENCH=1:
 *
 *   DAINTREE_BENCH=1 npx vitest run electron/workspace-host/__tests__/siblingFetch.bench.test.ts
 *
 * Wires real FetchSchedulers to one real RepoFetchCoordinator (git mocked with
 * a counting fake that takes 2 s per fetch) the way WorkspaceService does, then
 * advances fake time and counts the `git fetch` invocations that would have
 * hit the network, per remote. Also samples, every second, the age of each
 * remote's refs as seen by every worktree that reads them — the freshness the
 * cadence exists to bound — and reports the worst case after warm-up.
 */
import { describe, it, vi, afterEach } from "vitest";

const COMMON_DIR = "/repo/.git";
const fetchCounts = new Map<string, number>();

vi.mock("../../utils/gitUtils.js", () => ({
  getGitCommonDir: () => COMMON_DIR,
  getGitDir: vi.fn().mockReturnValue(null),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createBackgroundFetchGit: () => ({
    raw: (args: string[]) => {
      const remote = args[1]!;
      fetchCounts.set(remote, (fetchCounts.get(remote) ?? 0) + 1);
      return new Promise((resolve) => setTimeout(resolve, 2_000));
    },
  }),
}));

import { RepoFetchCoordinator } from "../RepoFetchCoordinator.js";
import { FetchScheduler, type FetchSchedulerHost } from "../FetchScheduler.js";

interface MonitorSpec {
  id: string;
  isCurrent: boolean;
  remotes: string[];
}

interface ScenarioResult {
  total: number;
  perRemote: Record<string, number>;
  maxAgeSec: Record<string, number>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runScenario(
  specs: MonitorSpec[],
  minutes: number,
  seed: number
): Promise<ScenarioResult> {
  fetchCounts.clear();
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  vi.spyOn(Math, "random").mockImplementation(mulberry32(seed));

  const coord = new RepoFetchCoordinator();
  const schedulers = specs.map((spec) => {
    const host: FetchSchedulerHost = {
      isRunning: true,
      pollingEnabled: true,
      isCurrent: spec.isCurrent,
      hasInitialStatus: true,
      hasFetchCallback: true,
      // Mirrors WorkspaceService.executeFetchForWorktree: forwards whatever the
      // scheduler hands over, so the same harness measures before and after.
      onExecuteFetch: (force: boolean, prune?: boolean, ...rest: unknown[]) =>
        coord.fetchForWorktree({
          worktreeId: spec.id,
          worktreePath: `/repo/${spec.id}`,
          force,
          prune,
          remotes: spec.remotes,
          primaryRemote: spec.remotes[0],
          ...(typeof rest[0] === "number" ? { maxAgeMs: rest[0] } : {}),
        }),
      onUpdate: () => {},
    };
    const scheduler = new FetchScheduler(host);
    scheduler.schedule(true);
    return scheduler;
  });

  const remotes = [...new Set(specs.flatMap((s) => s.remotes))];
  const maxAge: Record<string, number> = Object.fromEntries(remotes.map((r) => [r, 0]));
  const warmupMs = 60_000;
  const start = Date.now();
  for (let elapsed = 0; elapsed < minutes * 60_000; elapsed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
    if (elapsed < warmupMs) continue;
    for (const remote of remotes) {
      const last = coord.getLastSuccessfulFetch(COMMON_DIR, remote);
      const age = last === null ? Date.now() - start : Date.now() - last;
      maxAge[remote] = Math.max(maxAge[remote]!, age);
    }
  }

  for (const s of schedulers) s.clearTimer();
  coord.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();

  const perRemote = Object.fromEntries(remotes.map((r) => [r, fetchCounts.get(r) ?? 0]));
  return {
    total: Object.values(perRemote).reduce((a, b) => a + b, 0),
    perRemote,
    maxAgeSec: Object.fromEntries(remotes.map((r) => [r, Math.round(maxAge[r]! / 1000)])),
  };
}

function siblings(count: number, remotes: string[], prefix = "bg"): MonitorSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    isCurrent: false,
    remotes,
  }));
}

const SCENARIOS: Record<string, MonitorSpec[]> = {
  "10 bg + 1 focused (origin)": [
    { id: "focused", isCurrent: true, remotes: ["origin"] },
    ...siblings(10, ["origin"]),
  ],
  "10 bg, none focused (origin)": siblings(10, ["origin"]),
  "1 focused + 6 bg origin + 4 bg upstream-based": [
    { id: "focused", isCurrent: true, remotes: ["origin"] },
    ...siblings(6, ["origin"]),
    ...siblings(4, ["upstream", "origin"], "up"),
  ],
};

const SEEDS = [1, 2, 3, 4, 5];

describe.skipIf(!process.env.DAINTREE_BENCH)("sibling fetch benchmark", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const [name, specs] of Object.entries(SCENARIOS)) {
    for (const minutes of [30, 60]) {
      it(`${name} — ${minutes} min`, async () => {
        const runs: ScenarioResult[] = [];
        for (const seed of SEEDS) runs.push(await runScenario(specs, minutes, seed));
        const mean = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
        const remotes = Object.keys(runs[0]!.perRemote);
        const perRemote = remotes
          .map((r) => `${r}=${mean(runs.map((x) => x.perRemote[r]!))}`)
          .join(" ");
        const ages = remotes
          .map((r) => `${r}=${Math.max(...runs.map((x) => x.maxAgeSec[r]!))}s`)
          .join(" ");
        process.stderr.write(
          `[bench] ${name} ${minutes}min: fetches mean=${mean(runs.map((r) => r.total))} ` +
            `(runs ${runs.map((r) => r.total).join(",")}) per-remote ${perRemote} | max ref age ${ages}\n`
        );
      }, 120_000);
    }
  }
});
