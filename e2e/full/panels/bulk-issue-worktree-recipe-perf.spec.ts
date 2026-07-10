/* eslint-disable @typescript-eslint/no-explicit-any -- perf instrumentation crosses Playwright's process boundary */
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeApp, launchApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  connectGitHub,
  makeFixtureIssue,
  stubListIssues,
  stubRepoStats,
} from "../../helpers/githubHelpers";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_OUTPUT = path.join(REPO_ROOT, ".tmp", "perf-results", "bulk-issue-worktrees.json");
const RECIPE_NAME = "Bulk issue benchmark layout";
const READY_TIMEOUT_MS = 90_000;
const WHOLE_RUN_TIMEOUT_MS = 30 * 60_000;
const PAUSE_THRESHOLD_MS = 500;

function parseInteger(
  name: string,
  fallback: number,
  options: { allowZero?: boolean } = {}
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}, got '${raw}'`);
  }
  return value;
}

function parseScales(): number[] {
  const raw = process.env.PERF_BULK_ISSUE_SCALES ?? "1,6,10";
  const scales = raw.split(",").map((part) => Number(part.trim()));
  if (
    scales.length === 0 ||
    scales.some((scale) => !Number.isSafeInteger(scale) || scale < 1 || scale > 20)
  ) {
    throw new Error(`PERF_BULK_ISSUE_SCALES must contain integers from 1 to 20, got '${raw}'`);
  }
  if (new Set(scales).size !== scales.length) {
    throw new Error(`PERF_BULK_ISSUE_SCALES must not contain duplicates, got '${raw}'`);
  }
  return scales;
}

const CONFIG = {
  scales: parseScales(),
  rounds: parseInteger("PERF_BULK_ISSUE_ROUNDS", 3),
  warmups: parseInteger("PERF_BULK_ISSUE_WARMUPS", 1, { allowZero: true }),
  outputPath: path.resolve(REPO_ROOT, process.env.PERF_BULK_ISSUE_OUTPUT?.trim() || DEFAULT_OUTPUT),
};

interface TimedCall {
  startedAt: number;
  resolvedAt: number | null;
  failed: boolean;
  id?: string;
  branch?: string;
  spawnBatchId?: string;
  spawnBatchSize?: number;
}

interface HarnessMetrics {
  worktrees: TimedCall[];
  terminals: TimedCall[];
}

interface SampleMetrics {
  issueSelectionMs: number;
  dialogOpenMs: number;
  recipeSelectionMs: number;
  firstWorktreeStartedMs: number;
  allWorktreesResolvedMs: number;
  dialogDoneMs: number;
  firstTerminalStartedMs: number;
  allTerminalsSpawnedMs: number;
  totalFlowMs: number;
  maximumRendererFrameGapMs: number;
  largestTerminalAdmissionGapMs: number;
  terminalPauseCount: number;
  terminalsBeforeFirstPause: number;
}

interface BenchmarkSample {
  id: "PERF-182";
  scale: number;
  round: number;
  warmup: boolean;
  ok: boolean;
  metricsMs: SampleMetrics;
  counts: {
    issues: number;
    worktreesStarted: number;
    worktreesResolved: number;
    terminalsStarted: number;
    terminalsResolved: number;
    failedCalls: number;
  };
  errors: string[];
}

interface BenchmarkSummary {
  scale: number;
  count: number;
  failures: number;
  metricsMs: Record<keyof SampleMetrics, { median: number; p95: number }>;
}

interface ResultDocument {
  version: 1;
  generatedAt: string;
  config: typeof CONFIG;
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    fakeForge: true;
    fakeWorktrees: true;
    realTerminalPipeline: true;
  };
  samples: BenchmarkSample[];
  summaries: BenchmarkSummary[];
}

let resultDocument: ResultDocument;
let fixtureDir = "";
let fixtureCleanup: (() => void) | undefined;
let harnessTempDir = "";
let fakeBinDir = "";
let emptyZdotdir = "";

function percentile(values: number[], percent: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function buildSummaries(samples: BenchmarkSample[]): BenchmarkSummary[] {
  return CONFIG.scales.map((scale) => {
    const cells = samples.filter((sample) => !sample.warmup && sample.scale === scale);
    const successful = cells.filter((sample) => sample.ok);
    const metrics = {} as BenchmarkSummary["metricsMs"];
    const names = Object.keys(cells[0]?.metricsMs ?? {}) as Array<keyof SampleMetrics>;
    for (const name of names) {
      const values = successful.map((sample) => sample.metricsMs[name]);
      metrics[name] = { median: median(values), p95: percentile(values, 95) };
    }
    return {
      scale,
      count: successful.length,
      failures: cells.length - successful.length,
      metricsMs: metrics,
    };
  });
}

function persistResults(): void {
  resultDocument.generatedAt = new Date().toISOString();
  resultDocument.summaries = buildSummaries(resultDocument.samples);
  mkdirSync(path.dirname(CONFIG.outputPath), { recursive: true });
  const temporaryPath = `${CONFIG.outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(resultDocument, null, 2)}\n`);
  try {
    renameSync(temporaryPath, CONFIG.outputPath);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    try {
      unlinkSync(CONFIG.outputPath);
    } catch {
      // First write has no destination to remove.
    }
    renameSync(temporaryPath, CONFIG.outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function prepareFixture(): void {
  const fixture = createFixtureRepo({ name: "bulk-issue-worktree-perf", withGitHubRemote: true });
  fixtureDir = fixture.dir;
  fixtureCleanup = fixture.cleanup;
  harnessTempDir = mkdtempSync(path.join(os.tmpdir(), "daintree-bulk-issue-perf-"));
  fakeBinDir = path.join(harnessTempDir, "bin");
  emptyZdotdir = path.join(harnessTempDir, "zdotdir");
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(emptyZdotdir, { recursive: true });

  const executableName =
    process.platform === "win32" ? "daintree-bulk-perf-agent.js" : "daintree-bulk-perf-agent";
  const executablePath = path.join(fakeBinDir, executableName);
  writeFileSync(
    executablePath,
    [
      "#!/usr/bin/env node",
      "process.stdout.write('bulk-issue-ready\\n');",
      "process.stdin.resume();",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const shutdown = () => { clearInterval(keepAlive); process.exit(0); };",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(executablePath, 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "daintree-bulk-perf-agent.cmd"),
      ["@echo off", 'node "%~dp0daintree-bulk-perf-agent.js" %*', ""].join("\r\n")
    );
  }

  const recipesDir = path.join(fixtureDir, ".daintree", "recipes");
  mkdirSync(recipesDir, { recursive: true });
  writeFileSync(
    path.join(recipesDir, "bulk-issue-benchmark.json"),
    `${JSON.stringify(
      {
        id: "bulk-issue-benchmark-layout",
        name: RECIPE_NAME,
        terminals: [
          {
            type: "terminal",
            title: "Issue agent",
            command: "daintree-bulk-perf-agent",
            env: {},
          },
        ],
        createdAt: 1_700_000_000_000,
        showInEmptyState: false,
      },
      null,
      2
    )}\n`
  );
}

async function installHermeticHandlers(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { cwd }) => {
      const handlers = (ipcMain as any)._invokeHandlers as Map<
        string,
        (event: unknown, payload: any) => Promise<unknown>
      >;
      const originalTerminalSpawn = handlers.get("terminal:spawn");
      if (!originalTerminalSpawn) throw new Error("terminal:spawn handler is unavailable");

      const metrics: HarnessMetrics = { worktrees: [], terminals: [] };
      (globalThis as any).__bulkIssuePerfMetrics = metrics;

      const replace = (
        channel: string,
        handler: (event: unknown, payload: any) => Promise<unknown>
      ) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      };

      replace("worktree:get-available-branch", async (_event, payload) => payload.branchName);
      replace("worktree:get-default-path", async () => cwd);
      replace("worktree:create", async (_event, payload) => {
        const entry: TimedCall = {
          startedAt: Date.now(),
          resolvedAt: null,
          failed: false,
          branch: payload.options.newBranch,
        };
        metrics.worktrees.push(entry);
        await new Promise((resolve) => setTimeout(resolve, 1));
        entry.resolvedAt = Date.now();
        entry.id = `fake-worktree-${metrics.worktrees.length}-${payload.options.newBranch}`;
        return entry.id;
      });
      replace("worktree:set-active", async () => undefined);
      replace("terminal:spawn", async (event, payload) => {
        const entry: TimedCall = {
          startedAt: Date.now(),
          resolvedAt: null,
          failed: false,
          id: payload.id,
          spawnBatchId: payload.spawnBatchId,
          spawnBatchSize: payload.spawnBatchSize,
        };
        metrics.terminals.push(entry);
        try {
          const result = await originalTerminalSpawn(event, payload);
          entry.resolvedAt = Date.now();
          return result;
        } catch (error) {
          entry.failed = true;
          entry.resolvedAt = Date.now();
          throw error;
        }
      });
    },
    { cwd: fixtureDir }
  );
}

async function readHarnessMetrics(app: ElectronApplication): Promise<HarnessMetrics> {
  return await app.evaluate(() => {
    const metrics = (globalThis as any).__bulkIssuePerfMetrics as HarnessMetrics | undefined;
    if (!metrics) throw new Error("bulk issue perf metrics are unavailable");
    return structuredClone(metrics);
  });
}

async function startFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { gaps: [] as number[], last: performance.now(), requestId: 0 };
    const tick = (now: number) => {
      state.gaps.push(now - state.last);
      state.last = now;
      state.requestId = requestAnimationFrame(tick);
    };
    state.requestId = requestAnimationFrame(tick);
    (window as any).__bulkIssueFrameProbe = state;
  });
}

async function stopFrameProbe(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const state = (window as any).__bulkIssueFrameProbe as
      | { gaps: number[]; requestId: number }
      | undefined;
    if (!state) return 0;
    cancelAnimationFrame(state.requestId);
    delete (window as any).__bulkIssueFrameProbe;
    return state.gaps.length > 0 ? Math.max(...state.gaps) : 0;
  });
}

async function openIssuesDropdown(page: Page): Promise<void> {
  const pill = page.locator(SEL.github.statPillIssues);
  await expect(pill).toBeVisible({ timeout: T_MEDIUM });
  await expect(pill).not.toHaveAccessibleName(/Configure/, { timeout: T_MEDIUM });
  await pill.scrollIntoViewIfNeeded();
  await pill.click();
}

function analyzeAdmissionGaps(terminals: TimedCall[]): {
  largestGap: number;
  pauseCount: number;
  beforeFirstPause: number;
} {
  const starts = terminals.map((terminal) => terminal.startedAt).sort((a, b) => a - b);
  const gaps = starts.slice(1).map((startedAt, index) => startedAt - starts[index]!);
  const pauseIndex = gaps.findIndex((gap) => gap >= PAUSE_THRESHOLD_MS);
  return {
    largestGap: gaps.length > 0 ? Math.max(...gaps) : 0,
    pauseCount: gaps.filter((gap) => gap >= PAUSE_THRESHOLD_MS).length,
    beforeFirstPause: pauseIndex < 0 ? starts.length : pauseIndex + 1,
  };
}

async function runSample(scale: number, round: number, warmup: boolean): Promise<BenchmarkSample> {
  let ctx: AppContext | null = null;
  const errors: string[] = [];
  const pageErrors: string[] = [];
  const issueBase = round * 1_000 + (warmup ? 50_000 : 10_000);
  const issues = Array.from({ length: scale }, (_, index) =>
    makeFixtureIssue(issueBase + index + 1, `Bulk benchmark issue ${index + 1}`)
  );

  let issueSelectionMs = -1;
  let dialogOpenMs = -1;
  let recipeSelectionMs = -1;
  let dialogDoneMs = -1;
  let totalFlowMs = -1;
  let maximumRendererFrameGapMs = 0;
  let confirmStartedAt = 0;
  let backendReadyAt = 0;
  let harnessMetrics: HarnessMetrics = { worktrees: [], terminals: [] };

  try {
    ctx = await launchApp({
      env: {
        DAINTREE_E2E_FAULT_MODE: "1",
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        ZDOTDIR: emptyZdotdir,
      },
    });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      `Bulk issue perf N=${scale} R=${round}`
    );
    ctx.window.on("pageerror", (error) => pageErrors.push(error.message));

    await installHermeticHandlers(ctx.app);
    await connectGitHub(ctx.app, ctx.window);
    await stubRepoStats(
      ctx.app,
      { issueCount: issues.length, prCount: 0, commitCount: 1 },
      ctx.window
    );
    await stubListIssues(ctx.app, issues);

    await startFrameProbe(ctx.window);
    const flowStartedAt = Date.now();
    await openIssuesDropdown(ctx.window);
    await ctx.window.locator(SEL.github.searchIssues).fill("Bulk benchmark");
    await expect(ctx.window.locator(SEL.github.item(issues[0]!.number))).toBeVisible({
      timeout: T_LONG,
    });
    const selectAll = ctx.window
      .locator(SEL.github.selectionActions)
      .getByRole("button", { name: /Select all/ });
    await expect(selectAll).toBeVisible({ timeout: T_MEDIUM });
    await selectAll.click();
    issueSelectionMs = Date.now() - flowStartedAt;

    await expect(ctx.window.locator(SEL.github.bulkActionBar)).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.github.bulkCreateButton).click();
    const dialog = ctx.window.locator(SEL.github.bulkCreateDialog);
    await expect(dialog).toBeVisible({ timeout: T_LONG });
    dialogOpenMs = Date.now() - flowStartedAt;

    const assignmentToggle = dialog.getByRole("checkbox", {
      name: "Assign issues to me when creating worktrees",
    });
    if (await assignmentToggle.isChecked()) await assignmentToggle.uncheck();

    const recipeTrigger = ctx.window.locator("#bulk-recipe-selector-trigger");
    await expect(recipeTrigger).toBeVisible({ timeout: T_LONG });
    await recipeTrigger.click();
    const recipeList = ctx.window.locator("#bulk-recipe-selector");
    await expect(recipeList).toBeVisible({ timeout: T_MEDIUM });
    await recipeList.getByRole("option", { name: new RegExp(RECIPE_NAME, "i") }).click();
    await expect(recipeTrigger).toContainText(RECIPE_NAME, { timeout: T_MEDIUM });
    recipeSelectionMs = Date.now() - flowStartedAt;

    const confirm = dialog.locator('[data-testid="bulk-create-confirm-button"]');
    await expect(confirm).toHaveText(`Create ${scale} worktree${scale === 1 ? "" : "s"}`);
    confirmStartedAt = Date.now();
    await confirm.click();

    const done = dialog.locator('[data-testid="bulk-create-done-button"]');
    await expect(done).toBeVisible({ timeout: READY_TIMEOUT_MS });
    dialogDoneMs = Date.now() - confirmStartedAt;
    await expect(dialog).toContainText(`${scale} of ${scale} created`, { timeout: T_MEDIUM });
    await expect(dialog).not.toContainText("failed", { timeout: T_MEDIUM });

    await expect
      .poll(
        async () => {
          const current = await readHarnessMetrics(ctx!.app);
          return current.terminals.filter((terminal) => terminal.resolvedAt !== null).length;
        },
        { timeout: READY_TIMEOUT_MS, intervals: [25, 50, 100, 250] }
      )
      .toBe(scale);
    backendReadyAt = Date.now();
    totalFlowMs = backendReadyAt - flowStartedAt;
    harnessMetrics = await readHarnessMetrics(ctx.app);
    maximumRendererFrameGapMs = await stopFrameProbe(ctx.window);
  } catch (error) {
    errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
    if (ctx?.window && !ctx.window.isClosed()) {
      maximumRendererFrameGapMs = await stopFrameProbe(ctx.window).catch(() => 0);
    }
    if (ctx?.app) {
      harnessMetrics = await readHarnessMetrics(ctx.app).catch(() => harnessMetrics);
    }
  } finally {
    errors.push(...pageErrors.map((message) => `pageerror: ${message}`));
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
  }

  const resolvedWorktrees = harnessMetrics.worktrees.filter(
    (worktree) => worktree.resolvedAt !== null && !worktree.failed
  );
  const resolvedTerminals = harnessMetrics.terminals.filter(
    (terminal) => terminal.resolvedAt !== null && !terminal.failed
  );
  const failedCalls = [...harnessMetrics.worktrees, ...harnessMetrics.terminals].filter(
    (call) => call.failed
  ).length;
  if (harnessMetrics.worktrees.length !== scale) {
    errors.push(`observed ${harnessMetrics.worktrees.length}/${scale} fake worktree creates`);
  }
  if (resolvedWorktrees.length !== scale) {
    errors.push(`resolved ${resolvedWorktrees.length}/${scale} fake worktree creates`);
  }
  if (harnessMetrics.terminals.length !== scale) {
    errors.push(`observed ${harnessMetrics.terminals.length}/${scale} terminal spawns`);
  }
  if (resolvedTerminals.length !== scale) {
    errors.push(`resolved ${resolvedTerminals.length}/${scale} terminal spawns`);
  }
  if (failedCalls > 0) errors.push(`${failedCalls} instrumented calls failed`);

  const firstWorktreeStartedAt = Math.min(
    ...harnessMetrics.worktrees.map((worktree) => worktree.startedAt)
  );
  const lastWorktreeResolvedAt = Math.max(
    ...resolvedWorktrees.map((worktree) => worktree.resolvedAt!)
  );
  const firstTerminalStartedAt = Math.min(
    ...harnessMetrics.terminals.map((terminal) => terminal.startedAt)
  );
  const lastTerminalResolvedAt = Math.max(
    ...resolvedTerminals.map((terminal) => terminal.resolvedAt!)
  );
  const admission = analyzeAdmissionGaps(harnessMetrics.terminals);
  const fallbackEnd = backendReadyAt || Date.now();

  return {
    id: "PERF-182",
    scale,
    round,
    warmup,
    ok: errors.length === 0,
    metricsMs: {
      issueSelectionMs,
      dialogOpenMs,
      recipeSelectionMs,
      firstWorktreeStartedMs: Number.isFinite(firstWorktreeStartedAt)
        ? firstWorktreeStartedAt - confirmStartedAt
        : -1,
      allWorktreesResolvedMs: Number.isFinite(lastWorktreeResolvedAt)
        ? lastWorktreeResolvedAt - confirmStartedAt
        : -1,
      dialogDoneMs,
      firstTerminalStartedMs: Number.isFinite(firstTerminalStartedAt)
        ? firstTerminalStartedAt - confirmStartedAt
        : -1,
      allTerminalsSpawnedMs: Number.isFinite(lastTerminalResolvedAt)
        ? lastTerminalResolvedAt - confirmStartedAt
        : fallbackEnd - confirmStartedAt,
      totalFlowMs,
      maximumRendererFrameGapMs,
      largestTerminalAdmissionGapMs: admission.largestGap,
      terminalPauseCount: admission.pauseCount,
      terminalsBeforeFirstPause: admission.beforeFirstPause,
    },
    counts: {
      issues: scale,
      worktreesStarted: harnessMetrics.worktrees.length,
      worktreesResolved: resolvedWorktrees.length,
      terminalsStarted: harnessMetrics.terminals.length,
      terminalsResolved: resolvedTerminals.length,
      failedCalls,
    },
    errors,
  };
}

function printSummary(): void {
  console.table(
    resultDocument.summaries.map((summary) => ({
      N: summary.scale,
      Success: `${summary.count}/${summary.count + summary.failures}`,
      "Confirm → worktrees median ms": summary.metricsMs.allWorktreesResolvedMs?.median.toFixed(1),
      "Confirm → dialog done median ms": summary.metricsMs.dialogDoneMs?.median.toFixed(1),
      "Confirm → terminals median ms": summary.metricsMs.allTerminalsSpawnedMs?.median.toFixed(1),
      "Whole flow median ms": summary.metricsMs.totalFlowMs?.median.toFixed(1),
      "Largest admission gap median ms":
        summary.metricsMs.largestTerminalAdmissionGapMs?.median.toFixed(1),
      "Pauses median": summary.metricsMs.terminalPauseCount?.median.toFixed(1),
      "Max frame gap p95 ms": summary.metricsMs.maximumRendererFrameGapMs?.p95.toFixed(1),
    }))
  );
}

const perfDescribe = process.env.RUN_PERF_BULK_ISSUE_WORKTREES ? test.describe : test.describe.skip;

perfDescribe("Bulk issue worktree + recipe performance", () => {
  test("PERF-182 fake issues → fake worktrees → real recipe terminals", async () => {
    test.setTimeout(WHOLE_RUN_TIMEOUT_MS);
    prepareFixture();
    resultDocument = {
      version: 1,
      generatedAt: new Date().toISOString(),
      config: CONFIG,
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        fakeForge: true,
        fakeWorktrees: true,
        realTerminalPipeline: true,
      },
      samples: [],
      summaries: [],
    };
    persistResults();

    try {
      for (let warmup = 1; warmup <= CONFIG.warmups; warmup++) {
        const sample = await runSample(Math.min(...CONFIG.scales), warmup, true);
        resultDocument.samples.push(sample);
        persistResults();
        expect(sample.errors, `warmup ${warmup} passed reliability gates`).toEqual([]);
      }

      for (let round = 1; round <= CONFIG.rounds; round++) {
        const scales = round % 2 === 0 ? [...CONFIG.scales].reverse() : CONFIG.scales;
        for (const scale of scales) {
          const sample = await runSample(scale, round, false);
          resultDocument.samples.push(sample);
          persistResults();
          expect(sample.errors, `PERF-182 N=${scale} round=${round}`).toEqual([]);
        }
      }
    } finally {
      fixtureCleanup?.();
      if (harnessTempDir) removePathSync(harnessTempDir);
      persistResults();
      printSummary();
      console.log(`bulk issue worktree results: ${CONFIG.outputPath}`);
    }

    expect(
      resultDocument.samples.filter((sample) => !sample.warmup && !sample.ok),
      "every measured sample passed reliability gates"
    ).toEqual([]);
  });
});
