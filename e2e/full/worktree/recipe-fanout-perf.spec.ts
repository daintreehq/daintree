/* eslint-disable @typescript-eslint/no-explicit-any -- ActionService and perf buffers cross the Playwright serialization boundary */
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeRecipeFilename } from "@shared/utils/recipeFilename";
import { closeApp, launchApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_LONG } from "../../helpers/timeouts";

type BenchmarkMode = "existing-worktree" | "new-worktree";
type AgentMode = "fixture" | "vendor";
type PoolOutcome = "hit" | "miss" | "not-applicable" | "unknown";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_OUTPUT = path.join(REPO_ROOT, ".tmp", "perf-results", "recipe-fanout.json");
const SAMPLE_TIMEOUT_MS = 10 * 60_000;
const WHOLE_RUN_TIMEOUT_MS = 45 * 60_000;
const STARTUP_DEADLINE_MS = 120_000;
const SETTLE_MS = 750;
const MAX_RECIPE_TERMINALS = 10;
const RELEVANT_MARK =
  /^(agentlaunch\.|terminal_open_|terminal_first_write|terminal_data_|pty_pool_)/;

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

function parseSizes(): number[] {
  const raw = process.env.PERF_RECIPE_FANOUT_SIZES ?? "1,5,10";
  const values = raw.split(",").map((part) => Number(part.trim()));
  if (
    values.length === 0 ||
    values.some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > MAX_RECIPE_TERMINALS
    )
  ) {
    throw new Error(
      `PERF_RECIPE_FANOUT_SIZES must contain integers from 1 to ${MAX_RECIPE_TERMINALS}, got '${raw}'`
    );
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`PERF_RECIPE_FANOUT_SIZES must not contain duplicates, got '${raw}'`);
  }
  return values;
}

function parseAgentMode(): AgentMode {
  const raw = process.env.PERF_RECIPE_FANOUT_AGENT ?? "fixture";
  if (raw !== "fixture" && raw !== "vendor") {
    throw new Error(`PERF_RECIPE_FANOUT_AGENT must be 'fixture' or 'vendor', got '${raw}'`);
  }
  return raw;
}

const CONFIG = {
  sizes: parseSizes(),
  rounds: parseInteger("PERF_RECIPE_FANOUT_ROUNDS", 5),
  warmups: parseInteger("PERF_RECIPE_FANOUT_WARMUPS", 1, { allowZero: true }),
  seed: parseInteger("PERF_RECIPE_FANOUT_SEED", 180),
  agentMode: parseAgentMode(),
  outputPath: path.resolve(
    REPO_ROOT,
    process.env.PERF_RECIPE_FANOUT_OUTPUT?.trim() || DEFAULT_OUTPUT
  ),
};

interface SlotFixture {
  slot: number;
  title: string;
  token: string;
  tokenHash: string;
}

interface BenchmarkCase {
  id: "PERF-180" | "PERF-181";
  mode: BenchmarkMode;
  scale: number;
  round: number;
  recipeName: string;
  recipeFile: string;
  slots: SlotFixture[];
}

interface DispatchResult<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string };
}

interface RawMark {
  mark: string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
  source?: "file" | "renderer-buffer";
}

interface SequencedMark extends RawMark {
  sequence: number;
}

interface BrowserTerminalState {
  slot: number;
  title: string;
  panelId: string | null;
  committedMs: number;
  attachedMs: number;
  readyMs: number;
  tokenOccurrences: number;
  foreignTokenOccurrences: number;
}

interface ListedTerminal {
  id: string;
  worktreeId: string | null;
  title: string | null;
  location: string;
}

interface BrowserMeasurement {
  wallStartMs: number;
  wallRecipeStartMs: number;
  wallEndMs: number;
  recipeDispatchOffsetMs: number;
  recipeActionResolvedMs: number;
  worktreeCreateActionMs: number;
  worktreeCardVisibleMs: number;
  worktreeSelectionMs: number;
  firstPanelCommittedMs: number;
  allPanelsCommittedMs: number;
  firstXtermAttachedMs: number;
  allXtermsAttachedMs: number;
  frameGapsMs: number[];
  recipeResult: DispatchResult<{
    spawnedCount: number;
    failedCount: number;
    failedTerminals: Array<{ index: number; reason: string }>;
  }> | null;
  worktreeResult: DispatchResult<string> | null;
  worktreeId: string | null;
  beforeTerminalIds: string[];
  afterTerminals: ListedTerminal[];
  newDomPanelIds: string[];
  terminals: BrowserTerminalState[];
  rendererMarks: RawMark[];
  errors: string[];
  unhandledRejections: string[];
}

interface TerminalResult {
  slot: number;
  tokenHash: string;
  panelId: string | null;
  terminalId: string | null;
  worktreeId: string | null;
  hostSpawnDurationMs: number | null;
  attachLatencyMs: number | null;
  readinessLatencyMs: number | null;
  readinessFromRecipeMs: number | null;
  poolOutcome: PoolOutcome;
  finalCleanupState: "closed" | "still-present" | "unknown";
}

interface CleanupResult {
  durationMs: number;
  failureCount: number;
  failures: string[];
  panelsRemoved: boolean;
  terminalsRemoved: boolean;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  recipeRemoved: boolean;
}

interface SampleResult {
  id: "PERF-180" | "PERF-181";
  mode: BenchmarkMode;
  scale: number;
  round: number;
  ok: boolean;
  failure: string | null;
  counts: Record<string, number>;
  metricsMs: Record<string, number>;
  terminals: TerminalResult[];
  marks: RawMark[];
  frameGapsMs: number[];
  diagnostics: {
    pageErrors: string[];
    consoleErrors: string[];
    rendererCrashes: number;
    mainProcessExits: number;
    unhandledRejections: string[];
  };
  cleanup: CleanupResult;
}

interface MetricStats {
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
  standardDeviation: number;
}

interface CellSummary {
  id: "PERF-180" | "PERF-181";
  mode: BenchmarkMode;
  scale: number;
  count: number;
  failures: number;
  metricsMs: Record<string, MetricStats>;
}

interface ResultDocument {
  schemaVersion: 1;
  benchmark: "recipe-fanout-cold-spawn";
  generatedAt: string;
  git: {
    branch: string;
    commit: string;
    dirty: boolean;
  };
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    cpu: string;
    logicalCpuCount: number;
    memoryBytes: number;
    electronVersion: string;
    nodeVersion: string;
    agentMode: AgentMode;
  };
  configuration: {
    sizes: number[];
    rounds: number;
    warmups: number;
    seed: number;
  };
  samples: SampleResult[];
  summaries: CellSummary[];
}

interface ObservedErrors {
  pageErrors: string[];
  consoleErrors: string[];
  rendererCrashes: number;
  mainProcessExits: number;
}

let ctx: AppContext;
let fixtureDir = "";
let harnessTempDir = "";
let fakeBinDir = "";
let emptyZdotdir = "";
let metricsPath = "";
let mainWorktreeId = "";
let fixtureCleanup: (() => void) | undefined;
let cases: BenchmarkCase[] = [];
let warmupCases: BenchmarkCase[] = [];
let resultDocument: ResultDocument;
let observedErrors: ObservedErrors;
const recipeIds = new Map<string, string>();
const knownWorktrees = new Map<
  string,
  { branch: string; worktreePath: string; worktreeId?: string }
>();

function gitOutput(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createResultDocument(): ResultDocument {
  const cpus = os.cpus();
  return {
    schemaVersion: 1,
    benchmark: "recipe-fanout-cold-spawn",
    generatedAt: new Date().toISOString(),
    git: {
      branch: gitOutput(["branch", "--show-current"]),
      commit: gitOutput(["rev-parse", "HEAD"]),
      dirty: gitOutput(["status", "--porcelain"]).length > 0,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus[0]?.model ?? "unknown",
      logicalCpuCount: cpus.length,
      memoryBytes: os.totalmem(),
      electronVersion: "unknown",
      nodeVersion: process.versions.node,
      agentMode: CONFIG.agentMode,
    },
    configuration: {
      sizes: [...CONFIG.sizes],
      rounds: CONFIG.rounds,
      warmups: CONFIG.warmups,
      seed: CONFIG.seed,
    },
    samples: [],
    summaries: [],
  };
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.min(sorted.length - 1, rank)]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function metricStats(values: number[]): MetricStats {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
  return {
    min: Math.min(...values),
    median: median(values),
    p95: percentile(values, 95),
    max: Math.max(...values),
    mean,
    standardDeviation: Math.sqrt(variance),
  };
}

function buildSummaries(samples: SampleResult[]): CellSummary[] {
  const summaries: CellSummary[] = [];
  for (const mode of ["existing-worktree", "new-worktree"] as const) {
    for (const scale of CONFIG.sizes) {
      const cell = samples.filter((sample) => sample.mode === mode && sample.scale === scale);
      if (cell.length === 0) continue;
      const successful = cell.filter((sample) => sample.ok);
      const metricNames = new Set(successful.flatMap((sample) => Object.keys(sample.metricsMs)));
      const metricsMs: Record<string, MetricStats> = {};
      for (const name of metricNames) {
        const values = successful
          .map((sample) => sample.metricsMs[name])
          .filter((value): value is number => Number.isFinite(value) && value >= 0);
        if (values.length > 0) metricsMs[name] = metricStats(values);
      }
      summaries.push({
        id: mode === "existing-worktree" ? "PERF-180" : "PERF-181",
        mode,
        scale,
        count: successful.length,
        failures: cell.length - successful.length,
        metricsMs,
      });
    }
  }
  return summaries;
}

function persistResults(): void {
  if (!resultDocument) return;
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
      // The destination may not exist on the first write.
    }
    renameSync(temporaryPath, CONFIG.outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function rotate<T>(values: T[], amount: number): T[] {
  if (values.length === 0) return [];
  const offset = ((amount % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function makeCase(nonce: string, mode: BenchmarkMode, scale: number, round: number): BenchmarkCase {
  const modeId = mode === "existing-worktree" ? "existing" : "new";
  const id = mode === "existing-worktree" ? "PERF-180" : "PERF-181";
  const slug = `${modeId}-n${scale}-r${round}-${nonce}`;
  const recipeName = `Fanout ${id} ${slug}`;
  const slots = Array.from({ length: scale }, (_, index) => {
    const slot = index + 1;
    const token = `${modeId}-${scale}-${round}-${slot}-${nonce}`;
    return {
      slot,
      title: `Fanout ${modeId} n${scale} r${round} s${slot} ${nonce}`,
      token,
      tokenHash: hashToken(token),
    };
  });
  return {
    id,
    mode,
    scale,
    round,
    recipeName,
    recipeFile: safeRecipeFilename(recipeName),
    slots,
  };
}

function buildCaseMatrix(nonce: string): { measured: BenchmarkCase[]; warmups: BenchmarkCase[] } {
  const measured: BenchmarkCase[] = [];
  for (let round = 1; round <= CONFIG.rounds; round++) {
    const scales = rotate(CONFIG.sizes, CONFIG.seed + round - 1);
    const modes: BenchmarkMode[] =
      (CONFIG.seed + round) % 2 === 0
        ? ["existing-worktree", "new-worktree"]
        : ["new-worktree", "existing-worktree"];
    for (const scale of scales) {
      for (const mode of modes) {
        measured.push(makeCase(nonce, mode, scale, round));
      }
    }
  }

  const warmups = Array.from({ length: CONFIG.warmups }, (_, index) =>
    makeCase(`${nonce}-warmup-${index + 1}`, "existing-worktree", 1, 0)
  );
  return { measured, warmups };
}

function writeRecipe(benchmarkCase: BenchmarkCase, createdAt: number): void {
  const recipe = {
    id: randomUUID(),
    name: benchmarkCase.recipeName,
    terminals: benchmarkCase.slots.map((slot) => ({
      type: "claude",
      title: slot.title,
      initialPrompt: `Print exactly ${slot.token} on its own line, then wait.`,
      env: { PERF_RECIPE_READY_TOKEN: slot.token },
    })),
    createdAt,
    showInEmptyState: false,
  };
  const recipesDir = path.join(fixtureDir, ".daintree", "recipes");
  mkdirSync(recipesDir, { recursive: true });
  writeFileSync(
    path.join(recipesDir, benchmarkCase.recipeFile),
    `${JSON.stringify(recipe, null, 2)}\n`
  );
}

function prepareFixture(): void {
  const fixture = createFixtureRepo({ name: "recipe-fanout-perf" });
  fixtureDir = fixture.dir;
  fixtureCleanup = fixture.cleanup;
  harnessTempDir = mkdtempSync(path.join(os.tmpdir(), "daintree-recipe-fanout-"));
  fakeBinDir = path.join(harnessTempDir, "bin");
  emptyZdotdir = path.join(harnessTempDir, "zdotdir");
  metricsPath = path.join(harnessTempDir, "perf-marks.ndjson");
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(emptyZdotdir, { recursive: true });

  const nonce = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const matrix = buildCaseMatrix(nonce);
  cases = matrix.measured;
  warmupCases = matrix.warmups;

  if (CONFIG.agentMode === "fixture") {
    const implementationName = process.platform === "win32" ? "claude.js" : "claude";
    const fixturePath = path.join(fakeBinDir, implementationName);
    writeFileSync(
      fixturePath,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args.includes('--version') || args.includes('-v')) {",
        "  process.stdout.write('claude code v9.9.9\\n');",
        "  process.exit(0);",
        "}",
        "const token = process.env.PERF_RECIPE_READY_TOKEN;",
        "if (!token) {",
        "  process.stderr.write('PERF_RECIPE_READY_TOKEN missing\\n');",
        "  process.exit(2);",
        "}",
        "process.stdout.write(token + '\\n');",
        "process.stdin.resume();",
        "const keepAlive = setInterval(() => {}, 1000);",
        "const shutdown = () => { clearInterval(keepAlive); process.exit(0); };",
        "process.on('SIGINT', shutdown);",
        "process.on('SIGTERM', shutdown);",
        "",
      ].join("\n")
    );
    chmodSync(fixturePath, 0o755);
    if (process.platform === "win32") {
      writeFileSync(
        path.join(fakeBinDir, "claude.cmd"),
        ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
      );
    }
  }

  let createdAt = 1_700_000_000_000;
  for (const benchmarkCase of [...warmupCases, ...cases]) {
    writeRecipe(benchmarkCase, createdAt++);
  }
  writeFileSync(
    path.join(fixtureDir, "package.json"),
    `${JSON.stringify({ name: "recipe-fanout-perf", version: "1.0.0", private: true }, null, 2)}\n`
  );
  execFileSync("git", ["add", "-A"], { cwd: fixtureDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "recipe-fanout-perf-fixtures"], {
    cwd: fixtureDir,
    stdio: "ignore",
  });
}

function markFileOffset(): number {
  return existsSync(metricsPath) ? statSync(metricsPath).size : 0;
}

function readMarkDelta(offset: number): SequencedMark[] {
  if (!existsSync(metricsPath)) return [];
  const contents = readFileSync(metricsPath);
  const delta = contents.subarray(Math.min(offset, contents.length)).toString("utf8");
  const marks: SequencedMark[] = [];
  for (const [sequence, line] of delta.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RawMark;
      if (
        typeof parsed.mark === "string" &&
        typeof parsed.timestamp === "string" &&
        typeof parsed.elapsedMs === "number"
      ) {
        marks.push({ ...parsed, source: "file", sequence });
      }
    } catch {
      // A process interruption can leave the final NDJSON record truncated.
    }
  }
  return marks;
}

function actionError(label: string, result: DispatchResult<unknown> | null): string | null {
  if (!result) return `${label} did not resolve`;
  if (result.ok) return null;
  return `${label} failed: ${result.error?.message ?? "unknown error"}`;
}

function normalizePath(value: string): string {
  let normalized = path.normalize(value);
  try {
    normalized = realpathSync.native(normalized);
  } catch {
    // A failed sample may have already removed the path; lexical comparison is the fallback.
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

interface BrowserMeasurementInput {
  mode: BenchmarkMode;
  scale: number;
  recipeId: string;
  rootPath: string;
  mainWorktreeId: string;
  targetWorktreePath: string;
  branch: string | null;
  slots: Array<{ slot: number; title: string; token: string }>;
  startupDeadlineMs: number;
}

async function measureInBrowser(
  page: Page,
  input: BrowserMeasurementInput
): Promise<BrowserMeasurement> {
  return await page.evaluate(
    async ({
      mode,
      scale,
      recipeId,
      rootPath,
      mainWorktreeId,
      targetWorktreePath,
      branch,
      slots,
      startupDeadlineMs,
    }) => {
      const dispatch = (window as any).__daintreeDispatchAction as
        | ((id: string, args?: unknown, options?: unknown) => Promise<any>)
        | undefined;
      if (!dispatch) throw new Error("__daintreeDispatchAction is unavailable");

      const serializedErrorMessage = (error: unknown): string => {
        if (typeof error === "object" && error !== null && "message" in error) {
          return String((error as { message: unknown }).message);
        }
        return String(error);
      };

      const safeDispatch = async <T>(id: string, args?: unknown): Promise<DispatchResult<T>> => {
        try {
          const result = await dispatch(id, args, { source: "test" });
          if (result && typeof result.ok === "boolean") return result as DispatchResult<T>;
          return { ok: false, error: { message: `${id} returned an invalid result` } };
        } catch (error) {
          return {
            ok: false,
            error: { message: serializedErrorMessage(error) },
          };
        }
      };

      const listBefore = await safeDispatch<{ terminals: ListedTerminal[] }>("terminal.list");
      const beforeTerminals = listBefore.ok ? (listBefore.result?.terminals ?? []) : [];
      const beforeTerminalIds = beforeTerminals.map((terminal) => terminal.id);
      const beforeSet = new Set(beforeTerminalIds);
      const errors: string[] = [];
      if (!listBefore.ok) {
        errors.push(
          `terminal.list before launch failed: ${listBefore.error?.message ?? "unknown"}`
        );
      }

      const unhandledRejections: string[] = [];
      const rejectionHandler = (event: PromiseRejectionEvent) => {
        const reason = event.reason;
        unhandledRejections.push(serializedErrorMessage(reason));
      };
      window.addEventListener("unhandledrejection", rejectionHandler);

      const frameGapsMs: number[] = [];
      let lastFrame = performance.now();
      let frameNumber = 0;
      const nextFrame = async (): Promise<number> => {
        const now = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
        frameGapsMs.push(now - lastFrame);
        lastFrame = now;
        frameNumber++;
        return now;
      };

      const overallStart = performance.now();
      const wallStartMs = Date.now();
      let wallRecipeStartMs = wallStartMs;
      let recipeStart = overallStart;
      let recipeDispatchOffsetMs = 0;
      let recipeActionResolvedMs = -1;
      let worktreeCreateActionMs = -1;
      let worktreeCardVisibleMs = -1;
      let worktreeSelectionMs = -1;
      let worktreeResult: DispatchResult<string> | null = null;
      let targetWorktreeId = mainWorktreeId;

      if (mode === "new-worktree") {
        if (!branch) {
          errors.push("new-worktree sample has no branch name");
        } else {
          let createSettled = false;
          const createPromise = safeDispatch<string>("worktree.create", {
            rootPath,
            options: {
              baseBranch: "main",
              newBranch: branch,
              path: targetWorktreePath,
            },
          }).then((result) => {
            worktreeResult = result;
            worktreeCreateActionMs = performance.now() - overallStart;
            createSettled = true;
            if (result.ok && typeof result.result === "string") {
              targetWorktreeId = result.result;
            }
            return result;
          });

          const createDeadline = overallStart + startupDeadlineMs;
          const cardSelector = `[data-worktree-branch="${branch}"]`;
          while (performance.now() < createDeadline) {
            const now = await nextFrame();
            if (worktreeCardVisibleMs < 0 && document.querySelector(cardSelector)) {
              worktreeCardVisibleMs = now - overallStart;
            }
            if (createSettled && (worktreeCardVisibleMs >= 0 || !worktreeResult?.ok)) break;
          }
          await createPromise;
          if (!worktreeResult?.ok) {
            errors.push(
              `worktree.create failed: ${worktreeResult?.error?.message ?? "unknown error"}`
            );
          }
          if (worktreeCardVisibleMs < 0) {
            errors.push(`worktree card did not appear for branch ${branch}`);
          }

          if (worktreeResult?.ok && targetWorktreeId) {
            const selectionStart = performance.now();
            const selected = await safeDispatch<void>("worktree.select", {
              worktreeId: targetWorktreeId,
            });
            if (!selected.ok) {
              errors.push(`worktree.select failed: ${selected.error?.message ?? "unknown error"}`);
            } else {
              const selectionDeadline = selectionStart + 30_000;
              let selectionConfirmed = false;
              while (performance.now() < selectionDeadline) {
                const context = await safeDispatch<{ activeWorktreeId?: string }>(
                  "actions.getContext"
                );
                if (context.ok && context.result?.activeWorktreeId === targetWorktreeId) {
                  selectionConfirmed = true;
                  break;
                }
                await nextFrame();
              }
              worktreeSelectionMs = performance.now() - selectionStart;
              if (!selectionConfirmed) {
                errors.push(`worktree selection did not reach ${targetWorktreeId}`);
              }
            }
          }
        }
      }

      const states: BrowserTerminalState[] = slots.map((slot) => ({
        slot: slot.slot,
        title: slot.title,
        panelId: null,
        committedMs: -1,
        attachedMs: -1,
        readyMs: -1,
        tokenOccurrences: 0,
        foreignTokenOccurrences: 0,
      }));
      const tokenSeenFrame = new Map<number, number>();
      let firstPanelCommittedMs = -1;
      let allPanelsCommittedMs = -1;
      let firstXtermAttachedMs = -1;
      let allXtermsAttachedMs = -1;
      let recipeResult: BrowserMeasurement["recipeResult"] = null;
      let recipeSettled = false;
      let newDomPanelIds: string[] = [];

      const countOccurrences = (haystack: string, needle: string): number => {
        let count = 0;
        let offset = 0;
        while (true) {
          const index = haystack.indexOf(needle, offset);
          if (index < 0) return count;
          count++;
          offset = index + needle.length;
        }
      };

      const scanPanels = (now: number) => {
        const panelRoots = Array.from(
          document.querySelectorAll<HTMLElement>('[data-panel-location="grid"][data-panel-id]')
        );
        const newRoots = panelRoots.filter((root) => {
          const id = root.dataset.panelId;
          return id && !beforeSet.has(id);
        });
        newDomPanelIds = newRoots
          .map((root) => root.dataset.panelId)
          .filter((id): id is string => Boolean(id));

        if (newRoots.length > 0 && firstPanelCommittedMs < 0) {
          firstPanelCommittedMs = now - overallStart;
        }
        if (newRoots.length >= scale && allPanelsCommittedMs < 0) {
          allPanelsCommittedMs = now - overallStart;
        }

        for (const state of states) {
          const slot = slots.find((candidate) => candidate.slot === state.slot)!;
          if (!state.panelId) {
            const titleMatches = newRoots.filter((root) =>
              (root.textContent ?? "").includes(slot.title)
            );
            const tokenMatches = newRoots.filter((root) =>
              (root.querySelector(".xterm-rows")?.textContent ?? "").includes(slot.token)
            );
            const match = titleMatches.length === 1 ? titleMatches[0] : tokenMatches[0];
            if (match?.dataset.panelId) {
              state.panelId = match.dataset.panelId;
              state.committedMs = now - overallStart;
            }
          }

          const root = state.panelId
            ? newRoots.find((candidate) => candidate.dataset.panelId === state.panelId)
            : undefined;
          if (!root) continue;
          const xterm = root.querySelector<HTMLElement>(".xterm");
          if (xterm && xterm.getBoundingClientRect().width > 0 && state.attachedMs < 0) {
            state.attachedMs = now - overallStart;
            if (firstXtermAttachedMs < 0) firstXtermAttachedMs = state.attachedMs;
          }

          const text = root.querySelector(".xterm-rows")?.textContent ?? "";
          state.tokenOccurrences = countOccurrences(text, slot.token);
          state.foreignTokenOccurrences = slots.reduce(
            (count, candidate) =>
              candidate.slot === slot.slot
                ? count
                : count + countOccurrences(text, candidate.token),
            0
          );
          if (state.tokenOccurrences > 0 && !tokenSeenFrame.has(state.slot)) {
            tokenSeenFrame.set(state.slot, frameNumber);
          } else if (
            state.tokenOccurrences > 0 &&
            state.readyMs < 0 &&
            frameNumber > (tokenSeenFrame.get(state.slot) ?? frameNumber)
          ) {
            state.readyMs = now - overallStart;
          }
        }

        if (states.every((state) => state.attachedMs >= 0) && allXtermsAttachedMs < 0) {
          allXtermsAttachedMs = now - overallStart;
        }
      };

      if (errors.length === 0) {
        recipeStart = performance.now();
        wallRecipeStartMs = Date.now();
        recipeDispatchOffsetMs = recipeStart - overallStart;
        const recipePromise = safeDispatch<{
          spawnedCount: number;
          failedCount: number;
          failedTerminals: Array<{ index: number; reason: string }>;
        }>("recipe.run", {
          recipeId,
          worktreeId: targetWorktreeId,
          spawnedBy: "recipe",
          focusPolicy: "preserve",
        }).then((result) => {
          recipeResult = result;
          recipeActionResolvedMs = performance.now() - recipeStart;
          recipeSettled = true;
          return result;
        });

        const launchDeadline = recipeStart + startupDeadlineMs;
        while (performance.now() < launchDeadline) {
          const now = await nextFrame();
          scanPanels(now);
          if (recipeSettled && !recipeResult?.ok) break;
          if (recipeSettled && states.every((state) => state.readyMs >= 0)) break;
        }

        if (!recipeSettled) {
          await Promise.race([
            recipePromise,
            new Promise<void>((resolve) => window.setTimeout(resolve, 5_000)),
          ]);
        }
        if (!recipeSettled) errors.push("recipe.run did not resolve before the sample deadline");
        if (recipeResult && !recipeResult.ok) {
          errors.push(`recipe.run failed: ${recipeResult.error?.message ?? "unknown error"}`);
        }
        scanPanels(performance.now());
      }

      const missingPanels = states.filter((state) => !state.panelId).map((state) => state.slot);
      const missingAttach = states
        .filter((state) => state.attachedMs < 0)
        .map((state) => state.slot);
      const missingReady = states.filter((state) => state.readyMs < 0).map((state) => state.slot);
      if (missingPanels.length > 0) {
        errors.push(
          `missing panel commits for slots ${missingPanels.join(",")}; observed panel IDs=${newDomPanelIds.join(",") || "none"}`
        );
      }
      if (missingAttach.length > 0) {
        errors.push(`missing xterm attachment for slots ${missingAttach.join(",")}`);
      }
      if (missingReady.length > 0) {
        const known = states
          .filter((state) => state.panelId)
          .map((state) => `${state.slot}:${state.panelId}`)
          .join(",");
        errors.push(
          `missing painted readiness tokens for slots ${missingReady.join(",")}; known terminals=${known || "none"}`
        );
      }

      const listAfter = await safeDispatch<{ terminals: ListedTerminal[] }>("terminal.list");
      const afterTerminals = listAfter.ok ? (listAfter.result?.terminals ?? []) : [];
      if (!listAfter.ok) {
        errors.push(`terminal.list after launch failed: ${listAfter.error?.message ?? "unknown"}`);
      }

      const relevantIds = new Set([
        ...newDomPanelIds,
        ...afterTerminals
          .filter((terminal) => !beforeSet.has(terminal.id))
          .map((terminal) => terminal.id),
      ]);
      const relevantMark =
        /^(agentlaunch\.|terminal_open_|terminal_first_write|terminal_data_|pty_pool_)/;
      const rendererMarks = ((window as any).__DAINTREE_PERF_MARKS__ ?? []).filter(
        (mark: RawMark) => {
          if (!relevantMark.test(String(mark.mark))) return false;
          const id = mark.meta?.id ?? mark.meta?.terminalId;
          return typeof id === "string" && relevantIds.has(id);
        }
      ) as RawMark[];

      window.removeEventListener("unhandledrejection", rejectionHandler);
      return {
        wallStartMs,
        wallRecipeStartMs,
        wallEndMs: Date.now(),
        recipeDispatchOffsetMs,
        recipeActionResolvedMs,
        worktreeCreateActionMs,
        worktreeCardVisibleMs,
        worktreeSelectionMs,
        firstPanelCommittedMs,
        allPanelsCommittedMs,
        firstXtermAttachedMs,
        allXtermsAttachedMs,
        frameGapsMs,
        recipeResult,
        worktreeResult,
        worktreeId: targetWorktreeId || null,
        beforeTerminalIds,
        afterTerminals,
        newDomPanelIds,
        terminals: states,
        rendererMarks,
        errors,
        unhandledRejections,
      } satisfies BrowserMeasurement;
    },
    input
  );
}

function markTerminalId(mark: RawMark): string | null {
  const value = mark.meta?.terminalId ?? mark.meta?.id;
  return typeof value === "string" ? value : null;
}

function selectRelevantMarks(
  fileMarks: SequencedMark[],
  rendererMarks: RawMark[],
  terminalIds: Set<string>,
  cwd: string
): { file: SequencedMark[]; output: RawMark[] } {
  const expectedCwd = normalizePath(cwd);
  const relevantFile = fileMarks.filter((mark) => {
    if (!RELEVANT_MARK.test(mark.mark)) return false;
    if (mark.mark === "pty_pool_hit" || mark.mark === "pty_pool_miss") {
      const terminalId = markTerminalId(mark);
      if (terminalId !== null) return terminalIds.has(terminalId);
      return typeof mark.meta?.cwd === "string" && normalizePath(mark.meta.cwd) === expectedCwd;
    }
    const terminalId = markTerminalId(mark);
    return terminalId !== null && terminalIds.has(terminalId);
  });

  const combined: RawMark[] = [
    ...relevantFile.map(({ sequence: _sequence, ...mark }) => mark),
    ...rendererMarks
      .filter((mark) => {
        const terminalId = markTerminalId(mark);
        return RELEVANT_MARK.test(mark.mark) && terminalId !== null && terminalIds.has(terminalId);
      })
      .map((mark) => ({ ...mark, source: "renderer-buffer" as const })),
  ];
  const seen = new Set<string>();
  const output = combined
    .filter((mark) => {
      const key = `${mark.mark}\0${mark.timestamp}\0${JSON.stringify(mark.meta ?? {})}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return { file: relevantFile, output };
}

function elapsedFromWall(mark: RawMark | undefined, wallStartMs: number): number {
  if (!mark) return -1;
  return Math.max(0, Date.parse(mark.timestamp) - wallStartMs);
}

function createPendingSample(benchmarkCase: BenchmarkCase): SampleResult {
  return {
    id: benchmarkCase.id,
    mode: benchmarkCase.mode,
    scale: benchmarkCase.scale,
    round: benchmarkCase.round,
    ok: false,
    failure: "sample in progress",
    counts: { requested: benchmarkCase.scale },
    metricsMs: {},
    terminals: benchmarkCase.slots.map((slot) => ({
      slot: slot.slot,
      tokenHash: slot.tokenHash,
      panelId: null,
      terminalId: null,
      worktreeId: null,
      hostSpawnDurationMs: null,
      attachLatencyMs: null,
      readinessLatencyMs: null,
      readinessFromRecipeMs: null,
      poolOutcome: process.platform === "win32" ? "not-applicable" : "unknown",
      finalCleanupState: "unknown",
    })),
    marks: [],
    frameGapsMs: [],
    diagnostics: {
      pageErrors: [],
      consoleErrors: [],
      rendererCrashes: 0,
      mainProcessExits: 0,
      unhandledRejections: [],
    },
    cleanup: {
      durationMs: 0,
      failureCount: 0,
      failures: [],
      panelsRemoved: false,
      terminalsRemoved: false,
      worktreeRemoved: benchmarkCase.mode === "existing-worktree",
      branchRemoved: benchmarkCase.mode === "existing-worktree",
      recipeRemoved: false,
    },
  };
}

function populateMeasurement(
  sample: SampleResult,
  benchmarkCase: BenchmarkCase,
  browser: BrowserMeasurement,
  fileMarks: SequencedMark[]
): string[] {
  const failures = [...browser.errors];
  const beforeIds = new Set(browser.beforeTerminalIds);
  const newListed = browser.afterTerminals.filter((terminal) => !beforeIds.has(terminal.id));
  const measuredIds = new Set([
    ...newListed.map((terminal) => terminal.id),
    ...browser.newDomPanelIds,
    ...browser.terminals
      .map((terminal) => terminal.panelId)
      .filter((id): id is string => id !== null),
  ]);
  const relevant = selectRelevantMarks(
    fileMarks,
    browser.rendererMarks,
    measuredIds,
    benchmarkCase.mode === "new-worktree"
      ? (knownWorktrees.get(benchmarkCase.recipeName)?.worktreePath ?? fixtureDir)
      : fixtureDir
  );
  sample.marks = relevant.output;
  sample.frameGapsMs = browser.frameGapsMs;

  const hostStarts = relevant.file.filter(
    (mark) => mark.mark === "agentlaunch.host-spawn:start" && markTerminalId(mark)
  );
  const hostEnds = relevant.file.filter(
    (mark) => mark.mark === "agentlaunch.host-spawn:end" && markTerminalId(mark)
  );
  const hostStartById = new Map(hostStarts.map((mark) => [markTerminalId(mark)!, mark]));
  const hostEndById = new Map(hostEnds.map((mark) => [markTerminalId(mark)!, mark]));
  const poolMarks = relevant.file.filter(
    (mark) => mark.mark === "pty_pool_hit" || mark.mark === "pty_pool_miss"
  );
  const poolMisses = poolMarks.filter((mark) => mark.mark === "pty_pool_miss").length;
  const poolHits = poolMarks.filter((mark) => mark.mark === "pty_pool_hit").length;

  const listedById = new Map(newListed.map((terminal) => [terminal.id, terminal]));
  for (const terminal of sample.terminals) {
    const browserState = browser.terminals.find((state) => state.slot === terminal.slot);
    const listedByTitle = newListed.find(
      (candidate) => candidate.title === benchmarkCase.slots[terminal.slot - 1]?.title
    );
    const terminalId = browserState?.panelId ?? listedByTitle?.id ?? null;
    const listed = terminalId ? listedById.get(terminalId) : undefined;
    const hostStart = terminalId ? hostStartById.get(terminalId) : undefined;
    const hostEnd = terminalId ? hostEndById.get(terminalId) : undefined;
    const attributedPoolMarks = terminalId
      ? poolMarks.filter((mark) => markTerminalId(mark) === terminalId)
      : [];
    const bracketedPoolMarks =
      attributedPoolMarks.length > 0
        ? attributedPoolMarks
        : hostStart && hostEnd
          ? poolMarks.filter(
              (mark) => mark.sequence >= hostStart.sequence && mark.sequence <= hostEnd.sequence
            )
          : [];
    const poolOutcome: PoolOutcome =
      process.platform === "win32"
        ? "not-applicable"
        : bracketedPoolMarks.some((mark) => mark.mark === "pty_pool_hit")
          ? "hit"
          : bracketedPoolMarks.some((mark) => mark.mark === "pty_pool_miss")
            ? "miss"
            : "unknown";

    terminal.panelId = browserState?.panelId ?? terminalId;
    terminal.terminalId = terminalId;
    terminal.worktreeId = listed?.worktreeId ?? null;
    terminal.hostSpawnDurationMs =
      hostStart && hostEnd ? Math.max(0, hostEnd.elapsedMs - hostStart.elapsedMs) : null;
    terminal.attachLatencyMs =
      browserState && browserState.attachedMs >= 0
        ? Math.max(0, browserState.attachedMs - browser.recipeDispatchOffsetMs)
        : null;
    terminal.readinessLatencyMs =
      browserState && browserState.readyMs >= 0 ? browserState.readyMs : null;
    terminal.readinessFromRecipeMs =
      browserState && browserState.readyMs >= 0
        ? Math.max(0, browserState.readyMs - browser.recipeDispatchOffsetMs)
        : null;
    terminal.poolOutcome = poolOutcome;
  }

  const readyValues = sample.terminals
    .map((terminal) => terminal.readinessLatencyMs)
    .filter((value): value is number => value !== null);
  const maxFrameGap = browser.frameGapsMs.length > 0 ? Math.max(...browser.frameGapsMs) : 0;
  const firstHostStart = hostStarts.sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
  )[0];
  const lastHostEnd = hostEnds.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[
    hostEnds.length - 1
  ];
  const firstHostOverallMs = elapsedFromWall(firstHostStart, browser.wallStartMs);
  const lastHostOverallMs = elapsedFromWall(lastHostEnd, browser.wallStartMs);

  if (readyValues.length > 0) {
    sample.metricsMs.firstAgentReadyMs = Math.min(...readyValues);
    sample.metricsMs.allAgentsReadyMs = Math.max(...readyValues);
    sample.metricsMs.medianAgentReadyMs = median(readyValues);
    sample.metricsMs.p95AgentReadyMs = percentile(readyValues, 95);
    sample.metricsMs.readySpreadMs =
      sample.metricsMs.allAgentsReadyMs - sample.metricsMs.firstAgentReadyMs;
  }
  sample.metricsMs.recipeActionResolvedMs = browser.recipeActionResolvedMs;
  sample.metricsMs.firstPanelCommittedMs = browser.firstPanelCommittedMs;
  sample.metricsMs.allPanelsCommittedMs = browser.allPanelsCommittedMs;
  sample.metricsMs.firstXtermAttachedMs = browser.firstXtermAttachedMs;
  sample.metricsMs.allXtermsAttachedMs = browser.allXtermsAttachedMs;
  sample.metricsMs.firstHostSpawnStartedMs = firstHostOverallMs;
  sample.metricsMs.allHostSpawnsCompletedMs = lastHostOverallMs;
  sample.metricsMs.maximumRendererFrameGapMs = maxFrameGap;

  if (benchmarkCase.mode === "new-worktree") {
    sample.metricsMs.worktreeCreateActionMs = browser.worktreeCreateActionMs;
    sample.metricsMs.worktreeCardVisibleMs = browser.worktreeCardVisibleMs;
    sample.metricsMs.worktreeSelectionMs = browser.worktreeSelectionMs;
    sample.metricsMs.recipeDispatchOffsetMs = browser.recipeDispatchOffsetMs;
    sample.metricsMs.recipeActionResolvedFromCreateMs =
      browser.recipeDispatchOffsetMs + browser.recipeActionResolvedMs;
    sample.metricsMs.firstPanelCommittedFromRecipeMs =
      browser.firstPanelCommittedMs - browser.recipeDispatchOffsetMs;
    sample.metricsMs.allPanelsCommittedFromRecipeMs =
      browser.allPanelsCommittedMs - browser.recipeDispatchOffsetMs;
    sample.metricsMs.firstXtermAttachedFromRecipeMs =
      browser.firstXtermAttachedMs - browser.recipeDispatchOffsetMs;
    sample.metricsMs.allXtermsAttachedFromRecipeMs =
      browser.allXtermsAttachedMs - browser.recipeDispatchOffsetMs;
    sample.metricsMs.firstHostSpawnStartedFromRecipeMs = elapsedFromWall(
      firstHostStart,
      browser.wallRecipeStartMs
    );
    sample.metricsMs.allHostSpawnsCompletedFromRecipeMs = elapsedFromWall(
      lastHostEnd,
      browser.wallRecipeStartMs
    );
  }

  const recipeCounts = browser.recipeResult?.ok ? browser.recipeResult.result : undefined;
  const attachedCount = browser.terminals.filter((terminal) => terminal.attachedMs >= 0).length;
  const readyCount = browser.terminals.filter((terminal) => terminal.readyMs >= 0).length;
  const successfulHostEnds = hostEnds.filter((mark) => mark.meta?.success === true).length;
  const failedHostEnds = hostEnds.filter((mark) => mark.meta?.success !== true).length;
  sample.counts = {
    requested: benchmarkCase.scale,
    spawned: recipeCounts?.spawnedCount ?? 0,
    failed: recipeCounts?.failedCount ?? benchmarkCase.scale,
    committed: newListed.length,
    domCommitted: browser.newDomPanelIds.length,
    attached: attachedCount,
    ready: readyCount,
    poolMisses,
    poolHits,
    hostSpawnStarts: hostStarts.length,
    hostSpawnSuccesses: successfulHostEnds,
    hostSpawnFailures: failedHostEnds,
    rendererFrameGapsAbove50Ms: browser.frameGapsMs.filter((gap) => gap > 50).length,
    rendererFrameGapsAbove100Ms: browser.frameGapsMs.filter((gap) => gap > 100).length,
  };

  const recipeFailure = actionError("recipe.run", browser.recipeResult);
  if (recipeFailure) failures.push(recipeFailure);
  if (recipeCounts?.spawnedCount !== benchmarkCase.scale || recipeCounts.failedCount !== 0) {
    failures.push(
      `recipe.run counts were spawned=${recipeCounts?.spawnedCount ?? "missing"}, failed=${recipeCounts?.failedCount ?? "missing"}, expected ${benchmarkCase.scale}/0`
    );
  }
  if (newListed.length !== benchmarkCase.scale) {
    failures.push(
      `terminal.list found ${newListed.length} new panels, expected ${benchmarkCase.scale}`
    );
  }
  if (browser.newDomPanelIds.length !== benchmarkCase.scale) {
    failures.push(
      `DOM found ${browser.newDomPanelIds.length} new panels, expected ${benchmarkCase.scale}`
    );
  }
  if (new Set(newListed.map((terminal) => terminal.id)).size !== newListed.length) {
    failures.push("terminal.list returned duplicate terminal IDs");
  }
  for (const state of browser.terminals) {
    if (state.tokenOccurrences !== 1) {
      failures.push(
        `slot ${state.slot} token occurrence count was ${state.tokenOccurrences}, expected 1 in panel ${state.panelId ?? "missing"}`
      );
    }
    if (state.foreignTokenOccurrences !== 0) {
      failures.push(
        `slot ${state.slot} panel ${state.panelId ?? "missing"} rendered ${state.foreignTokenOccurrences} foreign token(s)`
      );
    }
  }
  if (hostStarts.length !== benchmarkCase.scale) {
    failures.push(
      `PTY host recorded ${hostStarts.length} spawn starts, expected ${benchmarkCase.scale}`
    );
  }
  if (successfulHostEnds !== benchmarkCase.scale || failedHostEnds !== 0) {
    failures.push(
      `PTY host recorded ${successfulHostEnds} successful and ${failedHostEnds} failed spawn ends, expected ${benchmarkCase.scale}/0`
    );
  }
  if (process.platform !== "win32") {
    if (poolMisses !== benchmarkCase.scale || poolHits !== 0) {
      failures.push(
        `PTY pool recorded ${poolMisses} misses and ${poolHits} hits, expected ${benchmarkCase.scale}/0`
      );
    }
    for (const terminal of sample.terminals) {
      if (terminal.poolOutcome !== "miss") {
        failures.push(
          `terminal ${terminal.terminalId ?? `slot ${terminal.slot}`} pool outcome was ${terminal.poolOutcome}, expected miss`
        );
      }
    }
  }
  const expectedWorktreeId = browser.worktreeId;
  for (const terminal of sample.terminals) {
    if (!terminal.terminalId || terminal.panelId !== terminal.terminalId) {
      failures.push(
        `slot ${terminal.slot} panel/terminal correlation failed (${terminal.panelId ?? "missing"}/${terminal.terminalId ?? "missing"})`
      );
    }
    if (!expectedWorktreeId || terminal.worktreeId !== expectedWorktreeId) {
      failures.push(
        `terminal ${terminal.terminalId ?? `slot ${terminal.slot}`} targeted worktree ${terminal.worktreeId ?? "missing"}, expected ${expectedWorktreeId ?? "missing"}`
      );
    }
  }
  return failures;
}

async function resolveWorktreePath(page: Page, branch: string): Promise<string> {
  return await page.evaluate(
    ({ rootPath, branchName }) =>
      (window as any).electron.worktree.getDefaultPath(rootPath, branchName) as Promise<string>,
    { rootPath: fixtureDir, branchName: branch }
  );
}

async function cleanupCase(
  benchmarkCase: BenchmarkCase,
  recipeId: string,
  panelIds: string[],
  targetWorktreeId: string | null
): Promise<CleanupResult & { remainingTerminalIds: string[] }> {
  const startedAt = Date.now();
  const failures: string[] = [];
  const recipePath = path.join(fixtureDir, ".daintree", "recipes", benchmarkCase.recipeFile);
  let remainingTerminalIds = [...panelIds];
  let recipeRemoved = false;
  let recipeStateDetails = "not checked";
  let worktreeActionSucceeded = benchmarkCase.mode === "existing-worktree";

  try {
    const browserCleanup = await ctx.window.evaluate(
      async ({ ids, titles, mode, targetWorktreeId, mainWorktreeId }) => {
        const dispatch = (window as any).__daintreeDispatchAction as (
          id: string,
          args?: unknown,
          options?: unknown
        ) => Promise<any>;
        const actionFailures: string[] = [];
        const serializedErrorMessage = (error: unknown): string => {
          if (typeof error === "object" && error !== null && "message" in error) {
            return String((error as { message: unknown }).message);
          }
          return String(error);
        };
        const run = async (id: string, args?: unknown) => {
          try {
            const result = await dispatch(id, args, { source: "test" });
            if (!result?.ok) {
              actionFailures.push(`${id}: ${result?.error?.message ?? "unknown error"}`);
            }
            return result;
          } catch (error) {
            actionFailures.push(`${id} rejected: ${serializedErrorMessage(error)}`);
            return null;
          }
        };

        const listed = await run("terminal.list");
        const titleSet = new Set(titles);
        const targetIds = new Set(ids);
        for (const terminal of listed?.ok ? (listed.result?.terminals ?? []) : []) {
          if (titleSet.has(terminal.title)) targetIds.add(terminal.id);
        }
        for (const terminalId of targetIds) {
          await run("terminal.kill", { terminalId, confirmed: true });
          await run("terminal.close", { terminalId });
        }

        if (mode === "new-worktree" && targetWorktreeId) {
          await run("worktree.select", { worktreeId: mainWorktreeId });
          const deleted = await run("worktree.delete", {
            worktreeId: targetWorktreeId,
            force: true,
            deleteBranch: true,
            closeTerminals: true,
          });
          if (!deleted?.ok) actionFailures.push("worktree.delete did not complete");
        }

        // recipe.run persists lastUsedAt asynchronously after returning.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const deadline = Date.now() + 30_000;
        let remaining: string[] = [];
        while (Date.now() < deadline) {
          const terminals = await run("terminal.list");
          const current = terminals?.ok ? (terminals.result?.terminals ?? []) : [];
          remaining = current
            .filter((terminal: { id: string }) => targetIds.has(terminal.id))
            .map((terminal: { id: string }) => terminal.id);
          if (remaining.length === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { actionFailures, remaining };
      },
      {
        ids: panelIds,
        titles: benchmarkCase.slots.map((slot) => slot.title),
        mode: benchmarkCase.mode,
        targetWorktreeId,
        mainWorktreeId,
      }
    );
    failures.push(...browserCleanup.actionFailures);
    remainingTerminalIds = browserCleanup.remaining;
    worktreeActionSucceeded =
      benchmarkCase.mode === "existing-worktree" ||
      !browserCleanup.actionFailures.some((failure: string) =>
        failure.startsWith("worktree.delete")
      );
  } catch (error) {
    failures.push(`browser cleanup failed: ${formatErrorMessage(error, "Unknown cleanup error")}`);
  }

  try {
    const recipeDeletion = await ctx.window.evaluate(async (runtimeRecipeId) => {
      const dispatch = (window as any).__daintreeDispatchAction;
      const before = await dispatch?.("recipe.list", {}, { source: "test" });
      const presentBefore = Boolean(
        before?.ok &&
        (before.result?.recipes ?? []).some(
          (recipe: { id: string }) => recipe.id === runtimeRecipeId
        )
      );
      if (!presentBefore) return { ok: true, error: null };
      const deleted = await dispatch?.(
        "recipe.delete",
        { recipeId: runtimeRecipeId },
        { source: "test" }
      );
      return {
        ok: Boolean(deleted?.ok),
        error: deleted?.ok ? null : (deleted?.error?.message ?? "recipe.delete failed"),
      };
    }, recipeId);
    if (!recipeDeletion.ok) failures.push(`recipe.delete: ${recipeDeletion.error}`);
  } catch (error) {
    failures.push(
      `recipe state cleanup failed: ${formatErrorMessage(error, "Unknown recipe cleanup error")}`
    );
  }
  try {
    unlinkSync(recipePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      failures.push(
        `fixture recipe removal failed: ${formatErrorMessage(error, "Unknown filesystem error")}`
      );
    }
  }
  try {
    await ctx.window.waitForTimeout(600);
    await ctx.window.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
    });
    const recipeState = await ctx.window.evaluate(async (runtimeRecipeId) => {
      const dispatch = (window as any).__daintreeDispatchAction;
      const deadline = Date.now() + 10_000;
      let matchingRecipes: Array<{ id: string; name: string }> = [];
      while (Date.now() < deadline) {
        const listed = await dispatch?.("recipe.list", {}, { source: "test" });
        matchingRecipes = listed?.ok
          ? (listed.result?.recipes ?? []).filter(
              (recipe: { id: string }) => recipe.id === runtimeRecipeId
            )
          : [];
        if (matchingRecipes.length === 0) return { removed: true, matchingRecipes };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { removed: false, matchingRecipes };
    }, recipeId);
    recipeRemoved = recipeState.removed;
    recipeStateDetails = JSON.stringify(recipeState.matchingRecipes);
  } catch (error) {
    failures.push(
      `recipe reload failed: ${formatErrorMessage(error, "Unknown recipe reload error")}`
    );
  }

  const worktree = knownWorktrees.get(benchmarkCase.recipeName);
  let worktreeRemoved = benchmarkCase.mode === "existing-worktree";
  let branchRemoved = benchmarkCase.mode === "existing-worktree";
  if (benchmarkCase.mode === "new-worktree" && worktree) {
    worktreeRemoved = !existsSync(worktree.worktreePath);
    try {
      const listed = gitOutput(["worktree", "list", "--porcelain"], fixtureDir);
      worktreeRemoved = worktreeRemoved && !listed.includes(worktree.worktreePath);
    } catch (error) {
      failures.push(
        `git worktree verification failed: ${formatErrorMessage(error, "Unknown git error")}`
      );
      worktreeRemoved = false;
    }
    try {
      branchRemoved =
        gitOutput(["branch", "--list", worktree.branch], fixtureDir).trim().length === 0;
    } catch (error) {
      failures.push(
        `git branch verification failed: ${formatErrorMessage(error, "Unknown git error")}`
      );
      branchRemoved = false;
    }
    if (!worktreeActionSucceeded) failures.push("normal worktree.delete cleanup failed");
  }

  const recipeFileExists = existsSync(recipePath);
  recipeRemoved = recipeRemoved && !recipeFileExists;
  if (remainingTerminalIds.length > 0) {
    failures.push(`terminals still present after cleanup: ${remainingTerminalIds.join(",")}`);
  }
  if (!worktreeRemoved) failures.push("worktree still present after cleanup");
  if (!branchRemoved) failures.push("worktree branch still present after cleanup");
  if (!recipeRemoved) {
    failures.push(
      `recipe still present after cleanup (disk=${recipeFileExists}, state=${recipeStateDetails})`
    );
  }

  await ctx.window.waitForTimeout(SETTLE_MS).catch(() => {});
  return {
    durationMs: Date.now() - startedAt,
    failureCount: failures.length,
    failures,
    panelsRemoved: remainingTerminalIds.length === 0,
    terminalsRemoved: remainingTerminalIds.length === 0,
    worktreeRemoved,
    branchRemoved,
    recipeRemoved,
    remainingTerminalIds,
  };
}

async function captureFailureScreenshot(
  benchmarkCase: BenchmarkCase,
  testInfo: TestInfo
): Promise<void> {
  const filename = `${benchmarkCase.id}-${benchmarkCase.mode}-n${benchmarkCase.scale}-r${benchmarkCase.round}-seed${CONFIG.seed}.png`;
  await ctx.window
    .screenshot({ path: testInfo.outputPath(filename), fullPage: true })
    .catch(() => {});
}

function printCellSummary(mode: BenchmarkMode, scale: number): void {
  const cell = resultDocument.samples.filter(
    (sample) => sample.mode === mode && sample.scale === scale
  );
  const successful = cell.filter((sample) => sample.ok);
  const metric = (name: string): number[] =>
    successful
      .map((sample) => sample.metricsMs[name])
      .filter((value): value is number => Number.isFinite(value) && value >= 0);
  const formatMedian = (name: string): string => {
    const values = metric(name);
    return values.length > 0 ? median(values).toFixed(1) : "n/a";
  };
  const formatP95 = (name: string): string => {
    const values = metric(name);
    return values.length > 0 ? percentile(values, 95).toFixed(1) : "n/a";
  };
  const frameGaps = metric("maximumRendererFrameGapMs");
  console.table([
    {
      Mode: mode,
      N: scale,
      Success: `${successful.length}/${cell.length}`,
      "All ready median ms": formatMedian("allAgentsReadyMs"),
      "All ready p95 ms": formatP95("allAgentsReadyMs"),
      "First ready median ms": formatMedian("firstAgentReadyMs"),
      "Spread median ms": formatMedian("readySpreadMs"),
      "Worktree create median ms":
        mode === "new-worktree" ? formatMedian("worktreeCreateActionMs") : "n/a",
      "Pool misses/hits": `${cell.reduce((sum, sample) => sum + (sample.counts.poolMisses ?? 0), 0)}/${cell.reduce((sum, sample) => sum + (sample.counts.poolHits ?? 0), 0)}`,
      "Max frame gap ms": frameGaps.length > 0 ? Math.max(...frameGaps).toFixed(1) : "n/a",
    },
  ]);
}

async function runSample(benchmarkCase: BenchmarkCase, testInfo: TestInfo): Promise<void> {
  const sample = createPendingSample(benchmarkCase);
  resultDocument.samples.push(sample);
  persistResults();

  const recipeId = recipeIds.get(benchmarkCase.recipeName);
  if (!recipeId) {
    sample.failure = `runtime recipe ID missing for '${benchmarkCase.recipeName}'`;
    persistResults();
    throw new Error(sample.failure);
  }

  const branch =
    benchmarkCase.mode === "new-worktree"
      ? `perf-fanout-n${benchmarkCase.scale}-r${benchmarkCase.round}-${hashToken(benchmarkCase.recipeName).slice(0, 8)}`
      : null;
  const targetWorktreePath = branch ? await resolveWorktreePath(ctx.window, branch) : fixtureDir;
  if (branch) {
    knownWorktrees.set(benchmarkCase.recipeName, { branch, worktreePath: targetWorktreePath });
  }

  const markOffset = markFileOffset();
  const observedStart = {
    pageErrors: observedErrors.pageErrors.length,
    consoleErrors: observedErrors.consoleErrors.length,
    rendererCrashes: observedErrors.rendererCrashes,
    mainProcessExits: observedErrors.mainProcessExits,
  };
  let browser: BrowserMeasurement | null = null;
  let failures: string[] = [];
  let screenshotCaptured = false;

  try {
    browser = await measureInBrowser(ctx.window, {
      mode: benchmarkCase.mode,
      scale: benchmarkCase.scale,
      recipeId,
      rootPath: fixtureDir,
      mainWorktreeId,
      targetWorktreePath,
      branch,
      slots: benchmarkCase.slots.map(({ slot, title, token }) => ({ slot, title, token })),
      startupDeadlineMs: STARTUP_DEADLINE_MS,
    });
    if (browser.worktreeId && branch) {
      const known = knownWorktrees.get(benchmarkCase.recipeName);
      if (known) known.worktreeId = browser.worktreeId;
    }
    failures = populateMeasurement(sample, benchmarkCase, browser, readMarkDelta(markOffset));
  } catch (error) {
    failures.push(
      `measurement threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
  }

  sample.diagnostics = {
    pageErrors: observedErrors.pageErrors.slice(observedStart.pageErrors),
    consoleErrors: observedErrors.consoleErrors.slice(observedStart.consoleErrors),
    rendererCrashes: observedErrors.rendererCrashes - observedStart.rendererCrashes,
    mainProcessExits: observedErrors.mainProcessExits - observedStart.mainProcessExits,
    unhandledRejections: browser?.unhandledRejections ?? [],
  };
  if (sample.diagnostics.pageErrors.length > 0) {
    failures.push(`page errors: ${sample.diagnostics.pageErrors.join(" | ")}`);
  }
  if (sample.diagnostics.consoleErrors.length > 0) {
    failures.push(`console errors: ${sample.diagnostics.consoleErrors.join(" | ")}`);
  }
  if (sample.diagnostics.rendererCrashes > 0) failures.push("renderer crashed during sample");
  if (sample.diagnostics.mainProcessExits > 0) failures.push("main process exited during sample");
  if (sample.diagnostics.unhandledRejections.length > 0) {
    failures.push(`unhandled rejections: ${sample.diagnostics.unhandledRejections.join(" | ")}`);
  }
  persistResults();

  if (failures.length > 0) {
    await captureFailureScreenshot(benchmarkCase, testInfo);
    screenshotCaptured = true;
  }

  const cleanupIds = sample.terminals
    .flatMap((terminal) => [terminal.panelId, terminal.terminalId])
    .filter((id): id is string => id !== null);
  const cleanup = await cleanupCase(
    benchmarkCase,
    recipeId,
    [...new Set(cleanupIds)],
    browser?.worktreeId ?? null
  );
  const { remainingTerminalIds: _remaining, ...persistedCleanup } = cleanup;
  sample.cleanup = persistedCleanup;
  for (const terminal of sample.terminals) {
    terminal.finalCleanupState = cleanup.remainingTerminalIds.includes(
      terminal.terminalId ?? terminal.panelId ?? ""
    )
      ? "still-present"
      : "closed";
  }
  failures.push(...cleanup.failures.map((failure) => `cleanup: ${failure}`));
  sample.ok = failures.length === 0;
  sample.failure = sample.ok ? null : failures.join("; ");
  if (!sample.ok && !screenshotCaptured) await captureFailureScreenshot(benchmarkCase, testInfo);
  persistResults();

  const completedCell = resultDocument.samples.filter(
    (candidate) => candidate.mode === benchmarkCase.mode && candidate.scale === benchmarkCase.scale
  );
  if (completedCell.length === CONFIG.rounds) {
    printCellSummary(benchmarkCase.mode, benchmarkCase.scale);
  }
}

async function closeInitialPanels(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const dispatch = (window as any).__daintreeDispatchAction;
    const listed = await dispatch?.("terminal.list", undefined, { source: "test" });
    for (const terminal of listed?.ok ? (listed.result?.terminals ?? []) : []) {
      await dispatch?.(
        "terminal.kill",
        { terminalId: terminal.id, confirmed: true },
        { source: "test" }
      );
      await dispatch?.("terminal.close", { terminalId: terminal.id }, { source: "test" });
    }
  });
  await expect.poll(() => page.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG }).toBe(0);
}

async function loadAndResolveRecipes(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const dispatch = (window as any).__daintreeDispatchAction;
    await dispatch?.("worktree.createDialog.open", undefined, { source: "test" });
  });
  await expect(page.locator(SEL.worktree.newDialog)).toBeVisible({ timeout: T_LONG });
  await page.keyboard.press("Escape");
  await expect(page.locator(SEL.worktree.newDialog)).not.toBeVisible({ timeout: T_LONG });

  const names = [...warmupCases, ...cases].map((benchmarkCase) => benchmarkCase.recipeName);
  const resolved = await page.evaluate(async (expectedNames) => {
    const dispatch = (window as any).__daintreeDispatchAction;
    const expected = new Set(expectedNames);
    let lastCount = 0;
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = await dispatch?.("recipe.list", {}, { source: "test" });
      const recipes = result?.ok ? (result.result?.recipes ?? []) : [];
      lastCount = recipes.length;
      const found = recipes.filter((recipe: { name: string }) => expected.has(recipe.name));
      if (found.length === expected.size) {
        return found.map((recipe: { id: string; name: string }) => ({
          id: recipe.id,
          name: recipe.name,
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`resolved ${lastCount} recipes but not all ${expected.size} benchmark recipes`);
  }, names);
  for (const recipe of resolved) recipeIds.set(recipe.name, recipe.id);
}

async function runWarmup(benchmarkCase: BenchmarkCase): Promise<void> {
  const recipeId = recipeIds.get(benchmarkCase.recipeName);
  if (!recipeId) throw new Error(`warmup recipe '${benchmarkCase.recipeName}' is unavailable`);
  const measured = await measureInBrowser(ctx.window, {
    mode: "existing-worktree",
    scale: 1,
    recipeId,
    rootPath: fixtureDir,
    mainWorktreeId,
    targetWorktreePath: fixtureDir,
    branch: null,
    slots: benchmarkCase.slots.map(({ slot, title, token }) => ({ slot, title, token })),
    startupDeadlineMs: STARTUP_DEADLINE_MS,
  });
  const failures = [...measured.errors];
  if (!measured.recipeResult?.ok || measured.recipeResult.result?.spawnedCount !== 1) {
    failures.push("warmup recipe did not spawn one terminal");
  }
  if (measured.terminals[0]?.readyMs === undefined || measured.terminals[0].readyMs < 0) {
    failures.push("warmup token did not paint");
  }
  const ids = measured.terminals
    .map((terminal) => terminal.panelId)
    .filter((id): id is string => id !== null);
  const cleanup = await cleanupCase(benchmarkCase, recipeId, ids, mainWorktreeId);
  failures.push(...cleanup.failures.map((failure) => `warmup cleanup: ${failure}`));
  if (failures.length > 0) throw new Error(failures.join("; "));
}

async function cleanupRemainingResources(): Promise<void> {
  if (ctx?.window && !ctx.window.isClosed()) {
    await ctx.window
      .evaluate(
        async ({ mainWorktreeId, recipeIds, worktreeIds }) => {
          const dispatch = (window as any).__daintreeDispatchAction;
          const listed = await dispatch?.("terminal.list", undefined, { source: "test" });
          for (const terminal of listed?.ok ? (listed.result?.terminals ?? []) : []) {
            if (!String(terminal.title ?? "").startsWith("Fanout ")) continue;
            await dispatch?.(
              "terminal.kill",
              { terminalId: terminal.id, confirmed: true },
              { source: "test" }
            );
            await dispatch?.("terminal.close", { terminalId: terminal.id }, { source: "test" });
          }
          await dispatch?.("worktree.select", { worktreeId: mainWorktreeId }, { source: "test" });
          for (const worktreeId of worktreeIds) {
            await dispatch?.(
              "worktree.delete",
              { worktreeId, force: true, deleteBranch: true, closeTerminals: true },
              { source: "test" }
            );
          }
          for (const recipeId of recipeIds) {
            await dispatch?.("recipe.delete", { recipeId }, { source: "test" });
          }
        },
        {
          mainWorktreeId,
          recipeIds: [...recipeIds.values()],
          worktreeIds: [...knownWorktrees.values()]
            .map((worktree) => worktree.worktreeId)
            .filter((id): id is string => typeof id === "string"),
        }
      )
      .catch(() => {});
  }
}

const perfDescribe = process.env.RUN_PERF_RECIPE_FANOUT ? test.describe : test.describe.skip;

perfDescribe("Cold recipe fanout performance", () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    resultDocument = createResultDocument();
    persistResults();
    prepareFixture();

    const launchEnv: Record<string, string> = {
      ZDOTDIR: emptyZdotdir,
      DAINTREE_IDENTITY_DEBUG_PASS: "1",
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: metricsPath,
    };
    if (CONFIG.agentMode === "fixture") {
      launchEnv.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`;
      launchEnv.DAINTREE_CLI_PATH_PREPEND = fakeBinDir;
    }
    ctx = await launchApp({ env: launchEnv });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Recipe Fanout Perf");
    resultDocument.environment.electronVersion = await ctx.app.evaluate(
      () => process.versions.electron ?? "unknown"
    );

    observedErrors = {
      pageErrors: [],
      consoleErrors: [],
      rendererCrashes: 0,
      mainProcessExits: 0,
    };
    ctx.window.on("pageerror", (error) => observedErrors.pageErrors.push(error.message));
    ctx.window.on("console", (message) => {
      if (message.type() === "error") observedErrors.consoleErrors.push(message.text());
    });
    ctx.window.on("crash", () => observedErrors.rendererCrashes++);
    ctx.app.process().on("exit", () => observedErrors.mainProcessExits++);

    await ctx.window.waitForTimeout(3_000);
    await ctx.window.evaluate(() => {
      (window as any).__DAINTREE_PERF_MARKS__ ||= [];
    });
    await closeInitialPanels(ctx.window);
    await loadAndResolveRecipes(ctx.window);
    const context = await ctx.window.evaluate(async () => {
      const dispatch = (window as any).__daintreeDispatchAction;
      return await dispatch?.("actions.getContext", undefined, { source: "test" });
    });
    mainWorktreeId = context?.ok ? (context.result?.activeWorktreeId ?? "") : "";
    if (!mainWorktreeId) throw new Error("main worktree ID is unavailable after onboarding");
    persistResults();
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    try {
      await cleanupRemainingResources();
      if (ctx?.app) await closeApp(ctx.app);
    } finally {
      for (const worktree of knownWorktrees.values()) {
        try {
          if (existsSync(worktree.worktreePath)) {
            execFileSync("git", ["worktree", "remove", "--force", worktree.worktreePath], {
              cwd: fixtureDir,
              stdio: "ignore",
            });
          }
        } catch {
          // The fixture cleanup below removes any remaining sibling path.
        }
        try {
          if (gitOutput(["branch", "--list", worktree.branch], fixtureDir)) {
            execFileSync("git", ["branch", "-D", worktree.branch], {
              cwd: fixtureDir,
              stdio: "ignore",
            });
          }
        } catch {
          // The fixture repository itself is removed below.
        }
      }
      fixtureCleanup?.();
      if (harnessTempDir) removePathSync(harnessTempDir);
      if (resultDocument) persistResults();
      console.log(`recipe fanout results: ${CONFIG.outputPath}`);
    }
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires an object-destructured fixture argument even when this Electron test uses none
  test("PERF-180 and PERF-181 cold recipe fanout matrix", async ({}, testInfo) => {
    test.setTimeout(WHOLE_RUN_TIMEOUT_MS);
    for (const warmup of warmupCases) {
      await test.step(`warmup ${warmup.recipeName}`, () => runWarmup(warmup), {
        timeout: SAMPLE_TIMEOUT_MS,
      });
    }

    for (const benchmarkCase of cases) {
      try {
        await test.step(
          `${benchmarkCase.id} ${benchmarkCase.mode} N=${benchmarkCase.scale} round=${benchmarkCase.round}`,
          () => runSample(benchmarkCase, testInfo),
          { timeout: SAMPLE_TIMEOUT_MS }
        );
      } catch (error) {
        const sample = [...resultDocument.samples]
          .reverse()
          .find(
            (candidate) =>
              candidate.mode === benchmarkCase.mode &&
              candidate.scale === benchmarkCase.scale &&
              candidate.round === benchmarkCase.round
          );
        if (sample) {
          sample.ok = false;
          sample.failure = [
            sample.failure,
            `sample step failed: ${formatErrorMessage(error, "Unknown sample error")}`,
          ]
            .filter(Boolean)
            .join("; ");
        }
        persistResults();
      }
    }

    const failures = resultDocument.samples
      .filter((sample) => !sample.ok)
      .map(
        (sample) =>
          `${sample.id} ${sample.mode} N=${sample.scale} round=${sample.round}: ${sample.failure}`
      );
    expect(failures, "every recipe fanout sample passed reliability gates").toEqual([]);
  });
});
