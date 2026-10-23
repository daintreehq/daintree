import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { launchApp, closeApp } from "../../e2e/helpers/launch";
import { createFixtureRepo } from "../../e2e/helpers/fixtures";
import { openAndOnboardProject } from "../../e2e/helpers/project";
import { getGridPanelIds } from "../../e2e/helpers/panels";
import {
  parseVanillaPanelCount,
  totalProcessMetrics,
  vanillaFixtureProblems,
  vanillaPluginPolicy,
  type ProcessMetric,
} from "./lib/vanillaPluginFixture";

/**
 * Opt-in reading of what vanilla Daintree (#14129) costs while it sits idle
 * with 20 or 100 terminals open and no plugin installed. Nothing gates on it:
 * the deterministic operation-count and bundle-boundary checks are the gate,
 * this is the number a person reads when one of them looks too lenient.
 *
 *   npm run perf vanilla-plugins -- --panels 20 --window-seconds 60
 *
 * Runs the built app (`npm run build:e2e` first, as for every e2e-driven
 * harness), not an installer. First interactive frame and per-channel plugin
 * IPC counts are not read here; they need the capture-only instrumentation of
 * `cold-start`/`launch-ab` and would add timers to the very idle window this
 * measures. `idleWakeupsPerSecond` is always 0 on Windows.
 */

interface BenchWindow {
  __daintreeDispatchAction(
    id: string,
    args: unknown,
    options: { source: "test" }
  ): Promise<unknown>;
}

const { values } = parseArgs({
  options: {
    panels: { type: "string", default: "20" },
    "window-seconds": { type: "string", default: "60" },
    output: { type: "string", default: ".tmp/perf-results/vanilla-plugins.json" },
  },
});
const panelCount = parseVanillaPanelCount(values.panels);
const windowSeconds = Number(values["window-seconds"]);
assert(Number.isFinite(windowSeconds) && windowSeconds >= 5 && windowSeconds <= 600);
const output = path.resolve(values.output);

interface RawMetric {
  type: string;
  name?: string;
  cpu: { cumulativeCPUUsage?: number; idleWakeupsPerSecond?: number };
  memory: { workingSetSize: number };
}

function toProcessMetrics(raw: RawMetric[]): ProcessMetric[] {
  return raw.map((metric) => ({
    type: metric.type,
    name: metric.name,
    cpuCumulativeSeconds: metric.cpu.cumulativeCPUUsage ?? 0,
    workingSetKb: metric.memory.workingSetSize,
    idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond ?? 0,
  }));
}

const fixture = createFixtureRepo({ name: "vanilla-plugins" });
const ctx = await launchApp({ headed: true });
try {
  const bootStart = Date.now();
  const page = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
  const openedMs = Date.now() - bootStart;

  for (let index = 0; index < panelCount; index++) {
    await page.evaluate(
      () =>
        (window as unknown as BenchWindow).__daintreeDispatchAction(
          "terminal.new",
          {},
          { source: "test" }
        ) as Promise<unknown>
    );
  }
  // The scan has settled once `plugin:list` answers with the built-ins.
  const plugins = await page.evaluate(() => window.electron.plugin.list());
  const livePanelCount = (await getGridPanelIds(page)).length;
  assert(
    livePanelCount === panelCount,
    `opened ${livePanelCount} of ${panelCount} terminals; addPanel refuses past the hardware panel limit (100 needs more than 32 GiB of RAM, see shared/utils/panelLimit.ts)`
  );
  const problems = vanillaFixtureProblems({
    panelCount,
    livePanelCount,
    installedPluginIds: plugins
      .filter((p) => !p.isBuiltin && p.origin === "global")
      .map((p) => p.instanceId),
    projectPluginIds: plugins.filter((p) => p.origin === "project").map((p) => p.instanceId),
  });
  assert.equal(problems.length, 0, `not a vanilla run: ${problems.join("; ")}`);

  const read = async (): Promise<ProcessMetric[]> =>
    toProcessMetrics(await ctx.app.evaluate(({ app }) => app.getAppMetrics()));

  // Let restoration, deferred service init and PTY hydration finish first.
  await delay(10_000);
  const before = totalProcessMetrics(await read());
  const samples: number[] = [];
  const deadline = Date.now() + windowSeconds * 1000;
  while (Date.now() < deadline) {
    await delay(Math.min(5_000, Math.max(0, deadline - Date.now())));
    samples.push(totalProcessMetrics(await read()).idleWakeupsPerSecond);
  }
  const after = totalProcessMetrics(await read());

  const report = {
    panelCount,
    windowSeconds,
    platform: process.platform,
    policy: vanillaPluginPolicy(),
    loadedPlugins: plugins.map((p) => p.instanceId).sort(),
    openProjectMs: openedMs,
    cpuSecondsInWindow: after.cpuSeconds - before.cpuSeconds,
    cpuPercentOfOneCore: ((after.cpuSeconds - before.cpuSeconds) / windowSeconds) * 100,
    workingSetKbEnd: after.workingSetKb,
    processCount: after.processCount,
    utilityProcessCountStart: before.utilityProcessCount,
    utilityProcessCountEnd: after.utilityProcessCount,
    idleWakeupsPerSecondMean: samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length),
    idleWakeupsAvailable: process.platform !== "win32",
  };
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeApp(ctx.app);
}
