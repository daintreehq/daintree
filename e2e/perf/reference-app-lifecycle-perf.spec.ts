import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { addAndSwitchToProject } from "../helpers/workflows";
import { mean, pct } from "../helpers/switchRotation";
import {
  LIFECYCLE_WORKLOAD,
  REFERENCE_APP_ID,
  REFERENCE_APP_SOURCE,
} from "../helpers/referenceAppLifecycle";
import {
  createReferenceAppProject,
  removeReferenceAppData,
} from "../plugins/helpers/referenceAppProject";

/**
 * Report-only readings for the reference-app workload (#14116): the Request
 * Desk build in six projects behind a two-view cache, each with its Home open
 * and 100 extra requests. It measures, it does not judge — no threshold here
 * gates anything, and none should be added until repeated unchanged-tree runs
 * on named hardware show the variance a budget would have to sit above.
 *
 * - `switch.warm` / `switch.cold`: wall time in the test process from the
 *   `project.switch` dispatch to the incoming project's own Home showing its own
 *   sentinel. Cold means the target had no renderer before the switch, checked
 *   against the view inventory, not assumed from the order. Includes
 *   Playwright's polling and IPC overhead, so it is an upper bound on what the
 *   user waits for and is comparable only with itself.
 * - `memory`: working set per process type from `app.getAppMetrics()`, after
 *   the rotation, with the cache full. Shared pages are counted per process.
 *   Electron reports no memory on Linux, so there it is null, not zero.
 * - `cpu.idle` / `cpu.active`: cumulative CPU time deltas per process (PID and
 *   creation time) over a fixed window, as a percentage of one core; processes
 *   that started or ended inside the window are counted, not folded in, and a
 *   window where no process exposed a counter reads null. Idle is the foreground
 *   Home with one cached background project; active is one report build plus
 *   the idle after it in the same window.
 *
 *   npm run perf reference-app-lifecycle
 *   RUN_PERF_REFERENCE_APP=1 npx playwright test --config=playwright.perf.config.ts --project=perf e2e/perf/reference-app-lifecycle-perf.spec.ts
 */

const LABEL = process.env.PERF_REFERENCE_APP_LABEL ?? "run";
const OUT_DIR = path.join(process.cwd(), ".tmp", "perf-results", "reference-app-lifecycle");
const APP_TIMEOUT = 60_000;
const SETTLE_MS = 500;

const perfDescribe = process.env.RUN_PERF_REFERENCE_APP ? test.describe.serial : test.describe.skip;

interface Desk {
  name: string;
  dir: string;
  cleanup: () => void;
  projectId: string;
  instanceId: string;
  sentinel: string;
}

interface Sample {
  target: string;
  cache: "warm" | "cold";
  ms: number;
}

interface CpuWindow {
  windowMs: number;
  byType: Record<string, number>;
  /** Null when no process exposed a cumulative counter at both ends. */
  totalPercentOfCore: number | null;
  measured: number;
  unavailable: number;
  /** Differences between the two snapshots; a process born and gone between them is invisible. */
  started: number;
  ended: number;
}

let ctx: AppContext;
const desks: Desk[] = [];

async function dispatch(page: Page, actionId: string, args?: unknown): Promise<void> {
  const result = await page.evaluate(
    async ([id, payload]) => {
      const run = (window as unknown as Record<string, unknown>).__daintreeDispatchAction as (
        id: string,
        args?: unknown,
        options?: { source: string }
      ) => Promise<{ ok: boolean; error?: unknown }>;
      return run(id, payload, { source: "user" });
    },
    [actionId, args] as const
  );
  if (!result.ok) throw new Error(`${actionId} failed: ${JSON.stringify(result.error)}`);
}

async function viewIds(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const pvm = (
      (globalThis as Record<string, unknown>).__daintreeGetPvm as (() => unknown) | undefined
    )?.() as { getViewInventory?: () => Array<{ projectId: string }> } | undefined;
    if (!pvm?.getViewInventory) throw new Error("PVM has no getViewInventory");
    return pvm.getViewInventory().map((entry) => entry.projectId);
  });
}

async function capCache(app: ElectronApplication): Promise<void> {
  await app.evaluate((_electron, limit) => {
    const pvm = (
      (globalThis as Record<string, unknown>).__daintreeGetPvm as (() => unknown) | undefined
    )?.() as
      | {
          setCachedViewLimit: (n: number) => void;
          setLowMemoryFreeThresholdMb: (mb: number | null) => void;
        }
      | undefined;
    if (!pvm) throw new Error("PVM unavailable");
    pvm.setLowMemoryFreeThresholdMb(null);
    pvm.setCachedViewLimit(limit);
  }, LIFECYCLE_WORKLOAD.cachedViewLimit);
}

async function trustAndOpenHome(page: Page, desk: Desk): Promise<void> {
  await page.evaluate(() => window.electron.plugin.setProjectPluginTrust("enabled"));
  let instanceId: string | undefined;
  await expect
    .poll(
      async () => {
        const rows = await page.evaluate(() => window.electron.plugin.getProjectPlugins());
        const row = rows.find((r) => r.id === REFERENCE_APP_ID);
        instanceId = row?.state === "active" ? row.instanceId : undefined;
        return instanceId !== undefined;
      },
      { timeout: APP_TIMEOUT }
    )
    .toBe(true);
  desk.instanceId = instanceId!;
  desk.projectId = (await page.evaluate(() => window.electron.project.getCurrent()))!.id;
  await expect
    .poll(
      () =>
        page
          .evaluate(([id]) => window.electron.plugin.invoke(id, "requests.list"), [desk.instanceId])
          .then(
            () => true,
            () => false
          ),
      { timeout: APP_TIMEOUT }
    )
    .toBe(true);
  await page.evaluate(
    async ([id, title, extra]) => {
      for (let i = 0; i < extra; i++) {
        await window.electron.plugin.invoke(id, "requests.add", { title: `Load ${i + 1}` });
      }
      // Last, so it is the most recently changed and always on Home's first page.
      await window.electron.plugin.invoke(id, "requests.add", { title });
    },
    [desk.instanceId, desk.sentinel, LIFECYCLE_WORKLOAD.perfExtraRequests] as const
  );
  await page.evaluate(
    ([id]) => window.electron.plugin.invoke(id, "connection.connect", { workspace: "Perf" }),
    [desk.instanceId] as const
  );
  await expect(homeSentinel(page, desk)).toBeVisible({
    timeout: APP_TIMEOUT,
  });
}

/** The application's Home, beside the grid, showing this project's own sentinel. */
function homeSentinel(page: Page, desk: Desk) {
  return page.getByTestId("project-home").getByText(desk.sentinel, { exact: true }).first();
}

async function measureSwitch(from: Page, desk: Desk): Promise<{ page: Page; sample: Sample }> {
  const cache = (await viewIds(ctx.app)).includes(desk.projectId) ? "warm" : "cold";
  const start = Date.now();
  await dispatch(from, "project.switch", { projectId: desk.projectId });
  let page = from;
  await expect
    .poll(
      async () => {
        page = await getActiveAppWindow(ctx.app, APP_TIMEOUT, { requireProject: true });
        const current = await page
          .evaluate(() => window.electron.project.getCurrent())
          .catch(() => null);
        return current?.id === desk.projectId;
      },
      { timeout: APP_TIMEOUT, intervals: [25] }
    )
    .toBe(true);
  await expect(homeSentinel(page, desk)).toBeVisible({
    timeout: APP_TIMEOUT,
  });
  const ms = Date.now() - start;
  await page.waitForTimeout(SETTLE_MS); // settle: post-switch eviction must not bleed into the next sample
  return { page, sample: { target: desk.name, cache, ms } };
}

async function metrics(app: ElectronApplication) {
  return app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      creationTime: m.creationTime,
      // Electron omits \`memory\` on Linux; privateBytes is Windows-only. Both in KB.
      workingSetKb: m.memory?.workingSetSize ?? null,
      privateKb: m.memory?.privateBytes ?? null,
      cumulativeCpuS: (m.cpu as { cumulativeCPUUsage?: number }).cumulativeCPUUsage ?? null,
    }))
  );
}

async function cpuWindow(app: ElectronApplication, page: Page, windowMs: number) {
  const before = await metrics(app);
  const t0 = Date.now();
  await page.waitForTimeout(windowMs); // the measured idle window itself
  const after = await metrics(app);
  const elapsed = Date.now() - t0;
  // A PID alone can be reused inside the window; with its creation time it can't.
  const key = (m: { pid: number; creationTime: number }) => `${m.pid}:${m.creationTime}`;
  const start = new Map(before.map((m) => [key(m), m]));
  const byType: Record<string, number> = {};
  let total = 0;
  let measured = 0;
  let unavailable = 0;
  for (const m of after) {
    const prior = start.get(key(m));
    if (!prior) continue;
    const delta =
      prior.cumulativeCpuS === null || m.cumulativeCpuS === null
        ? NaN
        : m.cumulativeCpuS - prior.cumulativeCpuS;
    if (!Number.isFinite(delta) || delta < 0) {
      unavailable += 1;
      continue;
    }
    // Cumulative CPU is in seconds: this is percent of one core, and may pass 100.
    const percent = (delta * 1000 * 100) / elapsed;
    byType[m.type] = (byType[m.type] ?? 0) + percent;
    total += percent;
    measured += 1;
  }
  const afterKeys = new Set(after.map(key));
  return {
    windowMs: elapsed,
    byType,
    totalPercentOfCore: measured > 0 ? total : null,
    measured,
    unavailable,
    started: after.filter((m) => !start.has(key(m))).length,
    ended: before.filter((m) => !afterKeys.has(key(m))).length,
  } satisfies CpuWindow;
}

function summarize(samples: readonly Sample[]) {
  const ms = samples.map((s) => s.ms);
  return ms.length === 0
    ? { n: 0 }
    : { n: ms.length, mean: mean(ms), p50: pct(ms, 50), p95: pct(ms, 95), raw: ms };
}

/** The reference payload measured, so a reading can be tied to the build it came from. */
function appDigest(): string {
  const root = path.join(process.cwd(), ...REFERENCE_APP_SOURCE.split("/"));
  const hash = createHash("sha256");
  const files = ["plugin.json", ...readdirSync(path.join(root, "dist")).map((f) => `dist/${f}`)];
  for (const file of files.sort()) {
    if (!statSync(path.join(root, file)).isFile()) continue;
    hash.update(file).update(readFileSync(path.join(root, file)));
  }
  return hash.digest("hex").slice(0, 16);
}

perfDescribe("Perf: reference app lifecycle (report only)", () => {
  test.beforeAll(async () => {
    for (const name of LIFECYCLE_WORKLOAD.projects) {
      const repo = createReferenceAppProject(name);
      desks.push({
        name,
        dir: repo.dir,
        cleanup: repo.cleanup,
        projectId: "",
        instanceId: "",
        sentinel: `Sentinel for ${name}`,
      });
    }
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    const homeDir = ctx?.homeDir;
    if (ctx?.app) await closeApp(ctx.app);
    for (const desk of desks) {
      if (homeDir) removeReferenceAppData(desk.projectId, homeDir);
      desk.cleanup();
    }
  });

  test("reports switch timings, memory and CPU for the reference workload", async () => {
    test.setTimeout(1_800_000);
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, desks[0].dir);
    await capCache(ctx.app);
    await trustAndOpenHome(ctx.window, desks[0]);
    for (const desk of desks.slice(1)) {
      ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, desk.dir, desk.name);
      await trustAndOpenHome(ctx.window, desk);
    }

    const samples: Sample[] = [];
    let page = ctx.window;
    // Cold: walk the ring, so every target was evicted two switches ago.
    let index = desks.length - 1;
    while (samples.filter((s) => s.cache === "cold").length < LIFECYCLE_WORKLOAD.perfColdSamples) {
      index = (index + 1) % desks.length;
      const result = await measureSwitch(page, desks[index]);
      page = result.page;
      samples.push(result.sample);
    }
    // Warm: toggle between the two projects the cache holds.
    let previous = desks[(index + desks.length - 1) % desks.length];
    let current = desks[index];
    while (samples.filter((s) => s.cache === "warm").length < LIFECYCLE_WORKLOAD.perfWarmSamples) {
      const result = await measureSwitch(page, previous);
      page = result.page;
      samples.push(result.sample);
      [previous, current] = [current, previous];
    }

    const memory = await metrics(ctx.app);
    const memoryByType: Record<string, { processes: number; workingSetMb: number | null }> = {};
    for (const m of memory) {
      const slot = (memoryByType[m.type] ??= { processes: 0, workingSetMb: null });
      slot.processes += 1;
      if (m.workingSetKb !== null)
        slot.workingSetMb = (slot.workingSetMb ?? 0) + m.workingSetKb / 1024;
    }

    const idle = await cpuWindow(ctx.app, page, LIFECYCLE_WORKLOAD.perfIdleWindowMs);
    // Active is one report build (the synthetic provider takes about six
    // seconds) and whatever idle follows it inside the same window. A build
    // that failed makes the reading meaningless, so it is checked.
    const report = (await page.evaluate(
      ([id]) => window.electron.plugin.invoke(id, "reports.start", { key: `perf-${Date.now()}` }),
      [current.instanceId] as const
    )) as { operationId: string };
    const active = await cpuWindow(ctx.app, page, LIFECYCLE_WORKLOAD.perfIdleWindowMs);
    await expect
      .poll(
        async () => {
          const reports = (await page.evaluate(
            ([id]) => window.electron.plugin.invoke(id, "reports.list"),
            [current.instanceId] as const
          )) as Array<{ operationId: string; state: string }>;
          return reports.find((r) => r.operationId === report.operationId)?.state;
        },
        { timeout: APP_TIMEOUT }
      )
      .toBe("succeeded");

    const versions = await ctx.app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }));
    const commit = (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      } catch {
        return "unknown";
      }
    })();
    const result = {
      label: LABEL,
      capturedAt: new Date().toISOString(),
      commit,
      hardware: {
        platform: process.platform,
        osRelease: os.release(),
        arch: os.arch(),
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCores: os.cpus().length,
        totalMemGb: Math.round(os.totalmem() / 1024 ** 3),
      },
      versions,
      workload: { ...LIFECYCLE_WORKLOAD, referenceAppDigest: appDigest() },
      switch: {
        warm: summarize(samples.filter((s) => s.cache === "warm")),
        cold: summarize(samples.filter((s) => s.cache === "cold")),
        samples,
      },
      memory: memoryByType,
      cpu: { idle, active },
    };

    mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `${LABEL}.json`);
    writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
    console.log(`[reference-app] wrote ${out}`);
    console.log(
      JSON.stringify({
        switch: { warm: result.switch.warm, cold: result.switch.cold },
        cpu: result.cpu,
      })
    );

    // Sanity, not a budget: both classes were actually observed.
    expect(result.switch.cold.n).toBe(LIFECYCLE_WORKLOAD.perfColdSamples);
    expect(result.switch.warm.n).toBe(LIFECYCLE_WORKLOAD.perfWarmSamples);
  });
});
