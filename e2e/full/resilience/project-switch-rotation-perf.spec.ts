/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync, execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../../helpers/launch";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import {
  createSwitchFixture,
  seedProjectWorkload,
  type SeededWorkload,
  type SwitchFixture,
} from "../../helpers/switchFixture";
import { getDescendantPids } from "../../helpers/stress";
import { SEL } from "../../helpers/selectors";
import {
  aggregate,
  DEFAULT_DEPTH_WEIGHTS,
  findMark,
  generateStackDistanceTrace,
  groupMarksBySwitch,
  parseNdjson,
  pct,
  summarizeSample,
  SWITCH_MARK,
  TIMING_KEYS,
  type CacheClass,
  type EntryPoint,
  type MarkRecord,
  type MemorySample,
  type MemoryViewSample,
  type RotationRapidBurst,
  type RotationResult,
  type RotationSample,
  type SampleTimings,
  type SwitchTraceStep,
} from "../../helpers/switchRotation";

// Real-UI project-switch rotation benchmark. Every isolated sample drives the
// shortcut, palette or toolbar the user would, waits for the target view to
// attach, types a nonce into the target's focused shell pane and reads the
// moment xterm painted it — so "done" means input-ready, not "IPC resolved".
// Depth (MRU stack distance) and cache cap are controlled so warm and cold
// switches are predicted before they happen and the app is held to the
// prediction. Latency, lag and memory are reported and written, never gated;
// the assertions are apparatus invariants only.
//   RUN_PERF_SWITCH_ROTATION=1 npx playwright test --project=full-resilience \
//     e2e/full/resilience/project-switch-rotation-perf.spec.ts
const CAP = Number(process.env.PERF_SWITCH_CAP ?? 3);
const LABEL = process.env.PERF_SWITCH_LABEL ?? `cap${CAP}`;
const OUTPUT_PATH =
  process.env.PERF_SWITCH_ROTATION_OUT ??
  path.join(process.cwd(), ".tmp", "perf-results", "project-switch-rotation", `${LABEL}.json`);
const SAMPLES_PER_DEPTH = Number(process.env.PERF_SWITCH_SAMPLES_PER_DEPTH ?? 20);
const SEED = Number(process.env.PERF_SWITCH_SEED ?? 1);
const EXTRA_STRATA = Number(process.env.PERF_SWITCH_EXTRA_STRATA ?? 5);
const RAPID_BURSTS = Number(process.env.PERF_SWITCH_RAPID_BURSTS ?? 3);
const INCLUDE_MARKS = process.env.PERF_SWITCH_INCLUDE_MARKS === "1";
const PROJECT_COUNT = 5;
const WORKTREES_PER_PROJECT = 3;
const AGENTS_PER_PROJECT = 3;
const FILES_PER_REPO = 180;
const STREAM_LINES_PER_SEC = 20;
const MAX_DEPTH = 4;
const WEIGHTS = DEFAULT_DEPTH_WEIGHTS;
const ENTRY_POINTS: EntryPoint[] = ["mru", "palette-keyboard", "palette-mouse", "toolbar"];

const IS_MAC = process.platform === "darwin";
const MRU_COMBO = IS_MAC ? "Meta+Alt+Equal" : "Control+Alt+Equal";
const PALETTE_COMBO = IS_MAC ? "Meta+Alt+p" : "Control+Alt+p";
// The toolbar dropdown carries the testid; the ⌘P modal is a plain dialog.
const PALETTE_ANY =
  '[data-testid="project-switcher-palette"], [role="dialog"][aria-label="Project switcher"]';
const PALETTE_INPUT = '[role="combobox"][aria-label="Search workspaces"]';
const SETTLE_CEILING_MS = 8_000;
const POST_SETTLE_MS = 300;
const RAPID_GAP_MS = 150;
const PURGE_IDLE_MS = 25_000;
const MEMORY_EVERY = 5;

const RENDERER_GONE_RE =
  /render-process-gone|Renderer process gone|Renderer crashed|Crash loop detected/;
const HARD_TIMEOUT_RE = /projectview\.(paintgate|warmpaintgate)\.hardtimeout/;

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

interface ProjectState {
  info: ProjectInfo;
  fixtureName: string;
  workload: SeededWorkload;
}

let ctx: AppContext;
let fixture: SwitchFixture | null = null;
const states = new Map<string, ProjectState>();

const perfDescribe = process.env.RUN_PERF_SWITCH_ROTATION
  ? test.describe.serial
  : test.describe.skip;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readMarks(): MarkRecord[] {
  if (!fixture || !existsSync(fixture.metricsPath)) return [];
  return parseNdjson(readFileSync(fixture.metricsPath, "utf8"));
}

function countLogMatches(logPath: string, sinceMs: number, needle: RegExp): number {
  if (!existsSync(logPath)) return 0;
  let count = 0;
  for (const line of readFileSync(logPath, "utf8").split(/\r?\n/)) {
    const ts = line.match(/^\[([^\]]+)\]/);
    if (!ts) continue;
    const atMs = Date.parse(ts[1]!);
    if (Number.isFinite(atMs) && atMs >= sinceMs && needle.test(line)) count++;
  }
  return count;
}

function gitHead(): string {
  try {
    return execSync("git rev-parse HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// ── Main-process view access ─────────────────────────────

async function getAttachedProjectId(): Promise<string | null> {
  return ctx.app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return null;
    const views = (win.contentView?.children ?? []) as Electron.WebContentsView[];
    for (let i = views.length - 1; i >= 0; i--) {
      const wc = views[i]?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      const id = await wc
        .executeJavaScript("window.__DAINTREE_INITIAL_PROJECT__?.id ?? null", true)
        .catch(() => null);
      if (typeof id === "string" && id.length > 0) return id;
    }
    return null;
  });
}

interface ViewEval<T> {
  found: boolean;
  value: T | null;
  error?: string;
}

/** Run a script inside the (possibly hidden, cached) view for a project. */
async function evaluateInProjectView<T>(projectId: string, script: string): Promise<ViewEval<T>> {
  return ctx.app.evaluate(
    async ({ BrowserWindow }, { projectId, script }) => {
      const g = globalThis as Record<string, unknown>;
      const pvm = (g.__daintreeGetPvm as (() => any) | undefined)?.();
      const candidates: Electron.WebContents[] = [];
      for (const entry of pvm?.getAllViews?.() ?? []) {
        const wc = entry?.view?.webContents as Electron.WebContents | undefined;
        if (wc && !wc.isDestroyed()) candidates.push(wc);
      }
      if (candidates.length === 0) {
        const win = BrowserWindow.getAllWindows()[0];
        for (const view of (win?.contentView?.children ?? []) as Electron.WebContentsView[]) {
          const wc = view?.webContents;
          if (wc && !wc.isDestroyed()) candidates.push(wc);
        }
      }
      for (const wc of candidates) {
        const id = await wc
          .executeJavaScript("window.__DAINTREE_INITIAL_PROJECT__?.id ?? null", true)
          .catch(() => null);
        if (id !== projectId) continue;
        try {
          const value = await Promise.race([
            wc.executeJavaScript(script, true),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("view eval timeout")), 10_000)
            ),
          ]);
          return { found: true, value: value as any };
        } catch (error) {
          return { found: true, value: null, error: String(error) };
        }
      }
      return { found: false, value: null };
    },
    { projectId, script }
  );
}

// ── Nonce probe (runs inside the target view) ────────────

function probeInstallScript(panelId: string, nonce: string): string {
  return `(() => {
    const w = window;
    const getTerm = w.__daintreeGetTerminalForE2E;
    const term = typeof getTerm === "function" ? getTerm(${JSON.stringify(panelId)}) : null;
    if (!term) return { armed: false, reason: "no-terminal" };
    if (w.__switchProbe && typeof w.__switchProbe.dispose === "function") w.__switchProbe.dispose();
    const nonce = ${JSON.stringify(nonce)};
    const panelId = ${JSON.stringify(panelId)};
    const state = { nonce, panelId, hits: 0, done: false, paintedAt: null, frameAt: null, dispose: null, renders: 0, lastScan: null };
    const scan = () => {
      // The echo lands on the cursor row, which on a tall, fresh pane is row 0,
      // so scan the whole viewport rather than the buffer tail.
      const buf = term.buffer.active;
      const start = buf.baseY;
      const end = Math.min(buf.length, start + term.rows);
      let hits = 0;
      for (let i = Math.max(0, start); i < end; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).includes(nonce)) hits++;
      }
      return hits;
    };
    const sub = term.onRender(() => {
      state.renders += 1;
      if (state.done) return;
      const hits = scan();
      state.lastScan = hits;
      if (hits === 0) return;
      state.hits = hits;
      state.done = true;
      state.paintedAt = performance.now();
      if (typeof w.__daintreeMarkPerf === "function") {
        w.__daintreeMarkPerf("project_switch.nonce_painted", { nonce, panelId });
      }
      requestAnimationFrame(() => {
        state.frameAt = performance.now();
        if (typeof w.__daintreeMarkPerf === "function") {
          w.__daintreeMarkPerf("project_switch.nonce_frame", { nonce, panelId });
        }
      });
    });
    state.dispose = () => sub.dispose();
    w.__switchProbe = state;
    return { armed: true };
  })()`;
}

const PROBE_READ_SCRIPT =
  "window.__switchProbe ? { done: window.__switchProbe.done, hits: window.__switchProbe.hits, nonce: window.__switchProbe.nonce, markHook: typeof window.__daintreeMarkPerf, renders: window.__switchProbe.renders, lastScan: window.__switchProbe.lastScan } : null";

/** Count buffer lines containing each nonce across the given panels, whole scrollback. */
function nonceCountScript(panelIds: string[], nonces: string[]): string {
  return `(() => {
    const getTerm = window.__daintreeGetTerminalForE2E;
    const panelIds = ${JSON.stringify(panelIds)};
    const nonces = ${JSON.stringify(nonces)};
    const hits = [];
    let checkedPanels = 0;
    for (const panelId of panelIds) {
      const term = typeof getTerm === "function" ? getTerm(panelId) : null;
      if (!term) continue;
      checkedPanels++;
      const counts = new Map();
      const buf = term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true);
        for (const nonce of nonces) {
          if (text.includes(nonce)) counts.set(nonce, (counts.get(nonce) ?? 0) + 1);
        }
      }
      for (const [nonce, count] of counts) hits.push({ panelId, nonce, count });
    }
    return { checkedPanels, hits };
  })()`;
}

interface NonceCount {
  checkedPanels: number;
  hits: Array<{ panelId: string; nonce: string; count: number }>;
}

// ── Memory ───────────────────────────────────────────────

async function takeMemorySample(phase: string, sampleIndex: number | null): Promise<MemorySample> {
  const attribution = await ctx.app
    .evaluate(async () => {
      const fn = (globalThis as Record<string, unknown>).__daintreeGetMemoryAttribution;
      return typeof fn === "function" ? await (fn as () => Promise<any>)() : null;
    })
    .catch(() => null);
  const metrics: Array<{ pid: number; type: string; name: string | null; workingSetKb: number }> =
    await ctx.app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        name: (m as any).name ?? (m as any).serviceName ?? null,
        workingSetKb: m.memory.workingSetSize,
      }))
    );
  let browserKb = 0;
  let gpuKb = 0;
  let rendererTotalKb = 0;
  const utilityByNameKb: Record<string, number> = {};
  const metricPids = new Set<number>();
  for (const m of metrics) {
    metricPids.add(m.pid);
    if (m.type === "Browser") browserKb += m.workingSetKb;
    else if (m.type === "GPU") gpuKb += m.workingSetKb;
    else if (m.type === "Tab") rendererTotalKb += m.workingSetKb;
    else if (m.type === "Utility") {
      const name = m.name ?? "unknown";
      utilityByNameKb[name] = (utilityByNameKb[name] ?? 0) + m.workingSetKb;
    }
  }
  // Shells and fake agents are children of the pty-host, not Chromium
  // processes, so app.getAppMetrics() never sees them.
  let ptyDescendantsKb = 0;
  const rootPid = ctx.app.process().pid;
  if (rootPid && process.platform !== "win32") {
    const foreign = getDescendantPids(rootPid).filter((pid) => !metricPids.has(pid));
    if (foreign.length > 0) {
      try {
        const out = execFileSync("ps", ["-o", "pid=,rss=", "-p", foreign.join(",")], {
          encoding: "utf8",
        });
        for (const line of out.split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(\d+)/);
          if (m) ptyDescendantsKb += Number(m[2]);
        }
      } catch {
        // A shell can exit between the pid walk and ps.
      }
    }
  }
  const views: MemoryViewSample[] = [];
  for (const win of attribution?.windows ?? []) {
    for (const view of win?.views ?? []) {
      views.push({
        projectId: view?.projectId ?? null,
        state: view?.state ?? null,
        webContentsId: view?.webContentsId ?? null,
        pid: view?.pid ?? null,
        workingSetKb: Number(view?.workingSetKb ?? 0),
        guestPids: Array.isArray(view?.guestPids) ? view.guestPids : [],
      });
    }
  }
  const utilityKb = Object.values(utilityByNameKb).reduce((a, b) => a + b, 0);
  return {
    at: new Date().toISOString(),
    phase,
    sampleIndex,
    totalKb: browserKb + gpuKb + rendererTotalKb + utilityKb + ptyDescendantsKb,
    browserKb,
    gpuKb,
    rendererTotalKb,
    unattributedRendererKb: Number(attribution?.processes?.unattributedRendererKb ?? NaN),
    utilityByNameKb,
    ptyDescendantsKb,
    views,
  };
}

// ── Entry-point drivers ──────────────────────────────────

async function dispatchOn(page: Page, actionId: string, args?: unknown): Promise<any> {
  return page
    .evaluate(
      async ([id, payload]) => {
        const fn = (window as any).__daintreeDispatchAction;
        return typeof fn === "function" ? fn(id, payload, { source: "test" }) : null;
      },
      [actionId, args] as const
    )
    .catch(() => null);
}

function newMainReceived(before: number, targetProjectId: string | null): MarkRecord | null {
  const records = readMarks();
  const fresh = records
    .slice(before)
    .filter(
      (r) =>
        r.mark === SWITCH_MARK.MAIN_RECEIVED &&
        (targetProjectId === null || r.meta?.targetProjectId === targetProjectId)
    );
  return fresh[fresh.length - 1] ?? null;
}

async function waitForSwitchStart(
  before: number,
  targetProjectId: string,
  timeoutMs: number
): Promise<MarkRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = newMainReceived(before, targetProjectId);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

async function openPalette(page: Page, viaToolbar: boolean): Promise<{ fallback: boolean }> {
  const palette = page.locator(PALETTE_ANY);
  if (viaToolbar) {
    await page.locator(SEL.toolbar.projectSwitcherTrigger).first().click({ force: true });
  } else {
    await page.keyboard.press(PALETTE_COMBO);
  }
  try {
    await expect(palette).toBeVisible({ timeout: 1_500 });
    return { fallback: false };
  } catch {
    // The chord can be swallowed by xterm's key handler; fall through.
  }
  // The action is a toggle, so only dispatch it when the palette is really
  // absent — dispatching over a palette that opened late would close it.
  if ((await palette.count()) === 0) {
    await dispatchOn(page, "project.switcherPalette");
    try {
      await expect(palette).toBeVisible({ timeout: 3_000 });
      return { fallback: true };
    } catch {
      // Last resort below.
    }
  }
  await page.locator(SEL.toolbar.projectSwitcherTrigger).first().click({ force: true });
  try {
    await expect(palette).toBeVisible({ timeout: 5_000 });
  } catch (error) {
    const diag = await page
      .evaluate(() => {
        const trigger = document.querySelector('[data-testid="project-switcher-trigger"]');
        return {
          project: (window as any).__DAINTREE_INITIAL_PROJECT__?.id ?? null,
          visibility: document.visibilityState,
          hasFocus: document.hasFocus(),
          activeElement: document.activeElement?.tagName ?? null,
          activeClass: document.activeElement?.className?.toString().slice(0, 80) ?? null,
          triggerPresent: Boolean(trigger),
          triggerDisabled: trigger?.hasAttribute("disabled") ?? null,
          triggerAria: trigger?.getAttribute("aria-expanded") ?? null,
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          cached: (window as any).electron?.app?.isViewCached?.() ?? null,
        };
      })
      .catch((e) => ({ evaluateError: String(e) }));
    const dispatchResult = await page
      .evaluate(async () => {
        const fn = (window as any).__daintreeDispatchAction;
        try {
          return {
            ok: true,
            value: await fn?.("project.switcherPalette", undefined, { source: "test" }),
          };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      })
      .catch((e) => ({ evaluateError: String(e) }));
    const views = await ctx.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const g = globalThis as any;
      const pvm = g.__daintreeGetPvm?.();
      return {
        children: (win?.contentView?.children ?? []).map((v: any) => v.webContents?.id ?? null),
        views: (pvm?.getAllViews?.() ?? []).map((v: any) => ({
          projectId: String(v.projectId).slice(0, 8),
          state: v.state,
          wc: v.view?.webContents?.id ?? null,
          destroyed: v.view?.webContents?.isDestroyed?.() ?? null,
        })),
        active: String(pvm?.getActiveProjectId?.() ?? "").slice(0, 8),
      };
    });
    console.log("[rotation] palette diagnostics", JSON.stringify({ diag, dispatchResult, views }));
    throw error;
  }
  return { fallback: true };
}

async function filterPaletteTo(page: Page, targetName: string): Promise<void> {
  const palette = page.locator(PALETTE_ANY);
  const input = page.locator(PALETTE_INPUT);
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(targetName);
  await expect
    .poll(
      async () => {
        const first = palette.locator('[role="option"]').first();
        const text = (await first.textContent().catch(() => "")) ?? "";
        const selected = await first.getAttribute("aria-selected").catch(() => null);
        return text.includes(targetName) && selected === "true";
      },
      { timeout: 5_000, intervals: [50, 100, 250] }
    )
    .toBe(true);
}

interface DriveResult {
  pressedAt: number;
  fallback: boolean;
}

/** Drive one switch through the real UI on `page`; returns when the input was sent. */
async function driveSwitch(
  page: Page,
  entryPoint: EntryPoint,
  targetProjectId: string,
  targetName: string,
  recordsBefore: number
): Promise<DriveResult> {
  if (entryPoint === "mru") {
    const pressedAt = Date.now();
    await page.keyboard.press(MRU_COMBO);
    if (await waitForSwitchStart(recordsBefore, targetProjectId, 1_500)) {
      return { pressedAt, fallback: false };
    }
    // xterm's key handler can swallow the chord on some layouts; the action
    // path is the same function the hook calls.
    const fallbackAt = Date.now();
    await dispatchOn(page, "project.mruCycleOlder");
    return { pressedAt: fallbackAt, fallback: true };
  }

  const { fallback } = await openPalette(page, entryPoint === "toolbar");
  await filterPaletteTo(page, targetName);
  const pressedAt = Date.now();
  if (entryPoint === "palette-keyboard") {
    await page.keyboard.press("Enter");
  } else {
    const option = page.locator(PALETTE_ANY).locator('[role="option"]').first();
    await option.click({ force: true, noWaitAfter: true });
  }
  if (await waitForSwitchStart(recordsBefore, targetProjectId, 3_000)) {
    return { pressedAt, fallback };
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  const fallbackAt = Date.now();
  await dispatchOn(page, "project.switch", { projectId: targetProjectId });
  return { pressedAt: fallbackAt, fallback: true };
}

async function waitForAttached(targetProjectId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await getAttachedProjectId()) === targetProjectId) return true;
    await sleep(10);
  }
  return false;
}

async function pageForProject(projectId: string): Promise<Page> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const page = await getActiveAppWindow(ctx.app, 60_000, { requireProject: true });
    const id = await page
      .evaluate(() => (window as any).__DAINTREE_INITIAL_PROJECT__?.id ?? null)
      .catch(() => null);
    if (id === projectId) return page;
    await sleep(100);
  }
  throw new Error(`active page never resolved to project ${projectId}`);
}

async function isProbeFocused(page: Page, probePanelId: string): Promise<boolean> {
  return page
    .evaluate((id) => {
      const el = document.activeElement;
      return Boolean(
        el &&
        el.classList.contains("xterm-helper-textarea") &&
        el.closest(`[data-panel-id="${id}"]`) !== null
      );
    }, probePanelId)
    .catch(() => false);
}

let warnedMissingMarkHook = false;

async function waitForProbeDone(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = (await page.evaluate(PROBE_READ_SCRIPT).catch(() => null)) as {
      done: boolean;
      markHook?: string;
    } | null;
    if (probe && probe.markHook !== "function" && !warnedMissingMarkHook) {
      warnedMissingMarkHook = true;
      console.log(`[rotation] probe has no __daintreeMarkPerf (typeof=${probe.markHook})`);
    }
    if (probe?.done) return true;
    await sleep(25);
  }
  const diag = await page
    .evaluate(() => {
      const w = window as any;
      const probe = w.__switchProbe;
      const term = probe ? w.__daintreeGetTerminalForE2E?.(probe.panelId) : null;
      const buf = term?.buffer?.active;
      const tail: string[] = [];
      if (buf) {
        for (let i = Math.max(0, buf.length - 4); i < buf.length; i++) {
          tail.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
      }
      return {
        probe: probe
          ? { done: probe.done, renders: probe.renders, lastScan: probe.lastScan }
          : null,
        bufLength: buf?.length ?? null,
        baseY: buf?.baseY ?? null,
        cursorY: buf?.cursorY ?? null,
        rows: term?.rows ?? null,
        tail,
        activeElement: document.activeElement?.className?.toString().slice(0, 60) ?? null,
      };
    })
    .catch((e) => ({ evaluateError: String(e) }));
  console.log(`[rotation] probe not done: ${JSON.stringify(diag)}`);
  return false;
}

interface SettleResult {
  settled: boolean;
  backstop: boolean;
}

/**
 * A sample is settled once main logged `settled` and the incoming view has run
 * its last reveal obligation: the 3 s repaint backstop for a warm view, or
 * first-interactive for a cold one (a cold view never receives the reveal
 * repaint event, so waiting on its backstop would only run out the ceiling).
 */
async function waitForSettle(switchId: string, cacheHit: boolean | null): Promise<SettleResult> {
  const deadline = Date.now() + SETTLE_CEILING_MS;
  let result: SettleResult = { settled: false, backstop: false };
  while (Date.now() < deadline) {
    const group = groupMarksBySwitch(readMarks()).bySwitch.get(switchId);
    if (group) {
      const backstop =
        cacheHit === false
          ? Boolean(findMark(group.marks, SWITCH_MARK.FIRST_INTERACTIVE))
          : group.marks.some(
              (r) => r.mark === SWITCH_MARK.REVEAL_REPAINT_DONE && r.meta?.pass === "backstop-3000"
            );
      result = { settled: Boolean(findMark(group.marks, SWITCH_MARK.SETTLED)), backstop };
      if (result.settled && result.backstop) break;
    }
    await sleep(250);
  }
  await sleep(POST_SETTLE_MS);
  return result;
}

function nanTimings(): SampleTimings {
  return Object.fromEntries(TIMING_KEYS.map((k) => [k, NaN])) as SampleTimings;
}

function fmt(v: number | undefined): string {
  return v === undefined || !Number.isFinite(v) ? "-" : `${Math.round(v)}`;
}

function mb(kb: number | undefined | null): string {
  return kb === undefined || kb === null || !Number.isFinite(kb)
    ? "-"
    : `${(kb / 1024).toFixed(0)}MB`;
}

perfDescribe("Resilience: project-switch rotation (real UI, nonce-to-paint)", () => {
  test.beforeAll(async () => {
    if (![3, 4, 5].includes(CAP)) throw new Error(`PERF_SWITCH_CAP must be 3, 4 or 5 (got ${CAP})`);
    fixture = createSwitchFixture({
      projects: PROJECT_COUNT,
      worktreesPerProject: WORKTREES_PER_PROJECT,
      filesPerRepo: FILES_PER_REPO,
      streamLinesPerSec: STREAM_LINES_PER_SEC,
    });
    // Real GPU + WebGL terminals: the default E2E launch disables both, which
    // renders a 6K window in software at a few frames per second and makes
    // every frame-paced interval here an artefact rather than a measurement.
    ctx = await launchApp({ env: fixture.launchEnv, enableWebgl: true });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixture?.cleanup();
  });

  test("rotates through every LRU depth with a typed nonce and reports latency and memory", async () => {
    test.setTimeout(1_800_000);
    const fx = fixture!;
    const logPath = path.join(ctx.userDataDir, "logs", "daintree.log");
    const runStartedAt = Date.now();

    // ── Setup: onboard, cap the cache, add and seed every project ──
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fx.projects[0]!.dir);
    await ctx.app.evaluate((_electron, limit) => {
      const g = globalThis as Record<string, unknown>;
      const pvm = (g.__daintreeGetPvm as (() => any) | undefined)?.();
      pvm?.setLowMemoryFreeThresholdMb?.(null);
      pvm?.setCachedViewLimit?.(limit);
    }, CAP);

    const resolveProject = async (dir: string): Promise<ProjectInfo> => {
      const all: ProjectInfo[] = await ctx.window.evaluate(() =>
        (window as any).electron.project.getAll()
      );
      // The app stores the canonical path; on macOS the fixture's tmpdir is
      // reached through the /var -> /private/var symlink, so compare real paths.
      const canon = (p: string) => {
        try {
          return realpathSync(p);
        } catch {
          return path.resolve(p);
        }
      };
      const want = canon(dir);
      const hit = all.find((p) => canon(p.path) === want);
      if (!hit) throw new Error(`project for ${dir} not registered`);
      return hit;
    };

    for (let i = 0; i < fx.projects.length; i++) {
      const project = fx.projects[i]!;
      if (i > 0) {
        ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, project.dir, project.name);
      }
      const info = await resolveProject(project.dir);
      const workload = await seedProjectWorkload(ctx.app, ctx.window, project);
      states.set(info.id, { info, fixtureName: project.name, workload });
      console.log(
        `[rotation] seeded ${project.name}: probe=${workload.probePanelId} agents=${workload.agentPanelIds.join(",")}`
      );
    }
    await sleep(3_000);

    const projectIds = fx.projects.map((p) => {
      const state = [...states.values()].find((s) => s.fixtureName === p.name)!;
      return state.info.id;
    });

    // Unmeasured warm-all rotation, visiting in reverse so the MRU stack ends
    // up in fixture order: head = project 0.
    for (const id of [...projectIds].reverse()) {
      if ((await getAttachedProjectId()) === id) continue;
      const page = await getActiveAppWindow(ctx.app, 60_000, { requireProject: true });
      await dispatchOn(page, "project.switch", { projectId: id });
      expect(await waitForAttached(id, 60_000), `warm-all switch to ${id}`).toBe(true);
      await sleep(1_000);
    }
    await sleep(2_000);

    const extraSteps: Array<{ depth: number; entryPoint: EntryPoint }> = [];
    for (let i = 0; i < EXTRA_STRATA; i++) {
      extraSteps.push({ depth: 1 + (i % 2), entryPoint: "palette-mouse" });
      extraSteps.push({ depth: 1 + ((i + 1) % 2), entryPoint: "toolbar" });
    }
    const trace = generateStackDistanceTrace({
      projectIds,
      samplesPerDepth: SAMPLES_PER_DEPTH,
      cap: CAP,
      maxDepth: MAX_DEPTH,
      seed: SEED,
      extraSteps,
    });

    const samples: RotationSample[] = [];
    const memorySamples: MemorySample[] = [];
    const nonces: string[] = [];
    let attachedMismatches = 0;
    let settleTimeouts = 0;
    const measureStartedAt = Date.now();

    // ── Isolated phase ──
    const runIsolated = async (step: SwitchTraceStep): Promise<void> => {
      const target = states.get(step.targetProjectId)!;
      const nonce = `sw${step.index}x${Math.random().toString(36).slice(2, 8)}`;
      nonces.push(nonce);
      const probeScript = probeInstallScript(target.workload.probePanelId, nonce);

      let probeArmedAfterSwitch = false;
      const preArm = await evaluateInProjectView<{ armed: boolean }>(
        step.targetProjectId,
        probeScript
      );
      if (!preArm.found || !preArm.value?.armed) probeArmedAfterSwitch = true;

      const recordsBefore = readMarks().length;
      const currentPage = await pageForProject(step.fromProjectId);
      console.log(
        `[rotation] step #${step.index} d${step.depth} ${step.entryPoint} ${states.get(step.fromProjectId)?.fixtureName} -> ${target.fixtureName} (${step.expectedCache})`
      );
      const drive = await driveSwitch(
        currentPage,
        step.entryPoint,
        step.targetProjectId,
        target.fixtureName,
        recordsBefore
      );

      const attached = await waitForAttached(step.targetProjectId, 20_000);
      if (!attached) attachedMismatches++;
      const targetPage = await pageForProject(step.targetProjectId);

      if (probeArmedAfterSwitch) {
        await expect
          .poll(
            async () => {
              const r = await targetPage.evaluate(probeScript).catch(() => null);
              return Boolean((r as any)?.armed);
            },
            { timeout: 15_000, intervals: [50, 100, 250] }
          )
          .toBe(true);
      }

      let focusRescued = false;
      let focusReadyAt = NaN;
      const focusDeadline = Date.now() + 5_000;
      while (Date.now() < focusDeadline) {
        if (await isProbeFocused(targetPage, target.workload.probePanelId)) {
          focusReadyAt = Date.now();
          break;
        }
        await sleep(20);
      }
      if (!Number.isFinite(focusReadyAt)) {
        focusRescued = true;
        const focusDiag = await targetPage
          .evaluate(() => {
            const el = document.activeElement;
            return {
              hasFocus: document.hasFocus(),
              tag: el?.tagName ?? null,
              cls: el?.className?.toString().slice(0, 60) ?? null,
              panel: el?.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? null,
            };
          })
          .catch((e) => ({ error: String(e) }));
        console.log(`[rotation] focus rescue #${step.index}: ${JSON.stringify(focusDiag)}`);
        await targetPage
          .locator(`[data-panel-id="${target.workload.probePanelId}"] ${SEL.terminal.xtermRows}`)
          .first()
          .click({ force: true });
        await expect
          .poll(() => isProbeFocused(targetPage, target.workload.probePanelId), {
            timeout: 5_000,
            intervals: [50, 100],
          })
          .toBe(true);
      }

      await targetPage.keyboard.type(nonce);
      await waitForProbeDone(targetPage, 6_000);
      const counted = (await targetPage
        .evaluate(nonceCountScript([target.workload.probePanelId], [nonce]))
        .catch(() => null)) as NonceCount | null;
      const nonceHits = counted ? counted.hits.reduce((sum, h) => sum + h.count, 0) : null;
      await targetPage.keyboard.press("Control+U");

      const mainReceived =
        newMainReceived(recordsBefore, step.targetProjectId) ??
        (await waitForSwitchStart(recordsBefore, step.targetProjectId, 5_000));
      const switchId = (mainReceived?.meta?.switchId as string | undefined) ?? null;
      let settle: SettleResult = { settled: false, backstop: false };
      if (switchId) {
        const mainReceivedRecord = newMainReceived(recordsBefore, step.targetProjectId);
        const cacheState = mainReceivedRecord?.meta?.cacheState;
        settle = await waitForSettle(
          switchId,
          cacheState === "warm" ? true : cacheState === "cold" ? false : null
        );
      } else await sleep(POST_SETTLE_MS);
      if (!settle.settled || !settle.backstop) settleTimeouts++;

      const grouped = groupMarksBySwitch(readMarks());
      const group = switchId ? grouped.bySwitch.get(switchId) : undefined;
      const summary = group
        ? summarizeSample(
            group,
            grouped.byNonce.get(nonce) ?? [],
            Number.isFinite(focusReadyAt) ? focusReadyAt - drive.pressedAt : NaN
          )
        : null;

      const sample: RotationSample = {
        index: step.index,
        phase: "isolated",
        switchId,
        entryPoint: step.entryPoint,
        entryPointFallback: drive.fallback,
        depth: step.depth,
        fromProjectId: step.fromProjectId,
        targetProjectId: step.targetProjectId,
        expectedCache: step.expectedCache,
        actualCache: summary?.actualCache ?? null,
        gateOutcome: summary?.gateOutcome ?? null,
        releaseChannel: summary?.releaseChannel ?? null,
        prefetchHit: summary?.prefetchHit ?? null,
        probeArmedAfterSwitch,
        focusRescued,
        nonce,
        nonceHits,
        anchorMark: summary?.anchorMark ?? null,
        orderingViolations: summary?.orderingViolations ?? [],
        settleTimedOut: !settle.settled || !settle.backstop,
        timings: summary?.timings ?? nanTimings(),
        lag: summary?.lag ?? {
          mainLoopLagMs: NaN,
          eventLoopLagOverlapMs: NaN,
          rendererLoafCount: 0,
          rendererLoafTotalMs: NaN,
        },
      };
      if ((step.index + 1) % MEMORY_EVERY === 0) {
        sample.memory = await takeMemorySample("isolated", step.index);
        memorySamples.push(sample.memory);
      }
      samples.push(sample);
      console.log(
        `[rotation] #${step.index} d${step.depth} ${step.entryPoint}${drive.fallback ? "(fallback)" : ""} ${step.expectedCache}/${sample.actualCache ?? "?"} nonce=${fmt(sample.timings.intentToNoncePaintedMs)}ms revealed=${fmt(sample.timings.intentToRevealedMs)}ms settled=${fmt(sample.timings.intentToSettledMs)}ms hits=${nonceHits ?? "?"}${focusRescued ? " focusRescued" : ""}${probeArmedAfterSwitch ? " armedAfter" : ""}`
      );
    };

    for (const step of trace) await runIsolated(step);

    const hot = await takeMemorySample("hot", null);
    memorySamples.push(hot);

    // ── Rapid phase: bursts of queued switches, no nonce ──
    const mruStack = (() => {
      const stack = [...projectIds];
      for (const step of trace) {
        stack.splice(stack.indexOf(step.targetProjectId), 1);
        stack.unshift(step.targetProjectId);
      }
      return stack;
    })();
    const bursts: RotationRapidBurst[] = [];
    const rapidPlan: Array<{ entryPoint: EntryPoint; depth: number }> = [
      { entryPoint: "mru", depth: 1 },
      { entryPoint: "mru", depth: 1 },
      { entryPoint: "mru", depth: 1 },
      { entryPoint: "palette-keyboard", depth: 2 },
      { entryPoint: "palette-keyboard", depth: 3 },
      { entryPoint: "mru", depth: 1 },
    ];
    for (let burst = 0; burst < RAPID_BURSTS; burst++) {
      const recordsBefore = readMarks().length;
      let finalTarget = mruStack[0]!;
      for (const step of rapidPlan) {
        const target = mruStack[step.depth]!;
        const targetState = states.get(target)!;
        const page = await getActiveAppWindow(ctx.app, 10_000, { requireProject: true });
        const before = readMarks().length;
        if (step.entryPoint === "mru") {
          await page.keyboard.press(MRU_COMBO);
          await sleep(RAPID_GAP_MS);
          if (!newMainReceived(before, null)) await dispatchOn(page, "project.mruCycleOlder");
        } else {
          try {
            await openPalette(page, false);
            await filterPaletteTo(page, targetState.fixtureName);
            await page.keyboard.press("Enter");
          } catch {
            await page.keyboard.press("Escape").catch(() => undefined);
            await dispatchOn(page, "project.switch", { projectId: target });
          }
          await sleep(RAPID_GAP_MS);
        }
        mruStack.splice(step.depth, 1);
        mruStack.unshift(target);
        finalTarget = target;
      }
      const attachedMatchedTarget = await waitForAttached(finalTarget, 60_000);
      // Every switch the burst produced, in arrival order; settle on the last.
      let mainReceiveds = readMarks()
        .slice(recordsBefore)
        .filter((r) => r.mark === SWITCH_MARK.MAIN_RECEIVED);
      const last = mainReceiveds[mainReceiveds.length - 1];
      if (last?.meta?.switchId) await waitForSettle(String(last.meta.switchId), null);
      const grouped = groupMarksBySwitch(readMarks());
      mainReceiveds = readMarks()
        .slice(recordsBefore)
        .filter((r) => r.mark === SWITCH_MARK.MAIN_RECEIVED);
      const switchIds = mainReceiveds
        .map((r) => String(r.meta?.switchId ?? ""))
        .filter((id) => id.length > 0);
      const queueDelaysMs: number[] = [];
      const settleMs: number[] = [];
      const gateOutcomes: Record<string, number> = {};
      for (const id of switchIds) {
        const group = grouped.bySwitch.get(id);
        if (!group) continue;
        const received = findMark(group.marks, SWITCH_MARK.MAIN_RECEIVED);
        const chain = findMark(group.marks, SWITCH_MARK.CHAIN_ENTERED);
        const settled = findMark(group.marks, SWITCH_MARK.SETTLED);
        const gate = findMark(group.marks, SWITCH_MARK.GATE_RESOLVED);
        if (received && chain) queueDelaysMs.push(chain.elapsedMs - received.elapsedMs);
        if (received && settled) settleMs.push(settled.elapsedMs - received.elapsedMs);
        const outcome = String(gate?.meta?.gateOutcome ?? "missing");
        gateOutcomes[outcome] = (gateOutcomes[outcome] ?? 0) + 1;
      }
      bursts.push({
        burst,
        switchIds,
        queueDelaysMs,
        settleMs,
        gateOutcomes,
        attachedMatchedTarget,
      });
      console.log(
        `[rotation] rapid burst ${burst}: switches=${switchIds.length} maxQueue=${fmt(Math.max(...queueDelaysMs, 0))}ms maxSettle=${fmt(Math.max(...settleMs, 0))}ms gates=${JSON.stringify(gateOutcomes)} landed=${attachedMatchedTarget}`
      );
      await sleep(2_000);
    }

    // ── Post-purge checkpoint and cross-PTY exclusivity ──
    await sleep(PURGE_IDLE_MS);
    const postPurge = await takeMemorySample("postPurge", null);
    memorySamples.push(postPurge);

    let crossPtyLeaks = 0;
    let uncheckedEvictedViews = 0;
    for (const state of states.values()) {
      const panelIds = [state.workload.probePanelId, ...state.workload.agentPanelIds];
      const result = await evaluateInProjectView<NonceCount>(
        state.info.id,
        nonceCountScript(panelIds, nonces)
      );
      if (!result.found || !result.value) {
        uncheckedEvictedViews++;
        continue;
      }
      // Every nonce was Ctrl+U'd out of its own probe line, so any surviving
      // occurrence anywhere is a byte that reached the wrong PTY.
      for (const hit of result.value.hits) {
        crossPtyLeaks += hit.count;
        console.log(
          `[rotation] LEAK: nonce ${hit.nonce} found ${hit.count}x in ${state.fixtureName} panel ${hit.panelId}`
        );
      }
    }

    // ── Aggregate, print, write ──
    const isolated = samples.filter((s) => s.phase === "isolated");
    const agg = aggregate(
      isolated.map((s) => ({
        depth: s.depth,
        actualCache: s.actualCache,
        expectedCache: s.expectedCache,
        entryPoint: s.entryPoint,
        timings: s.timings,
      })),
      WEIGHTS
    );
    const rendererGone = countLogMatches(logPath, runStartedAt, RENDERER_GONE_RE);
    const hardTimeoutLogs = countLogMatches(logPath, runStartedAt, HARD_TIMEOUT_RE);
    const hardTimeouts =
      hardTimeoutLogs +
      samples.filter((s) => s.gateOutcome === "hard-timeout").length +
      bursts.reduce((sum, b) => sum + (b.gateOutcomes["hard-timeout"] ?? 0), 0);
    const cacheMisclassified = isolated.filter((s) => s.actualCache !== s.expectedCache).length;
    const nonceLost = isolated.filter((s) => (s.nonceHits ?? 0) === 0).length;
    const nonceDuplicated = isolated.filter((s) => (s.nonceHits ?? 0) > 1).length;
    const samplesInvalid = isolated.filter(
      (s) => !s.switchId || !Number.isFinite(s.timings.intentToNoncePaintedMs)
    ).length;
    const allQueue = bursts.flatMap((b) => b.queueDelaysMs);
    const allSettle = bursts.flatMap((b) => b.settleMs);
    const rapidGates: Record<string, number> = {};
    for (const b of bursts) {
      for (const [k, v] of Object.entries(b.gateOutcomes)) rapidGates[k] = (rapidGates[k] ?? 0) + v;
    }

    const result: RotationResult = {
      label: LABEL,
      platform: process.platform,
      arch: process.arch,
      createdAt: new Date().toISOString(),
      commit: gitHead(),
      config: {
        cap: CAP,
        projects: PROJECT_COUNT,
        worktreesPerProject: WORKTREES_PER_PROJECT,
        agentsPerProject: AGENTS_PER_PROJECT,
        filesPerRepo: FILES_PER_REPO,
        samplesPerDepth: SAMPLES_PER_DEPTH,
        seed: SEED,
        weights: WEIGHTS,
        entryPoints: ENTRY_POINTS,
        rapidBursts: RAPID_BURSTS,
      },
      apparatus: {
        rendererGone,
        hardTimeouts,
        cacheMisclassified,
        nonceLost,
        nonceDuplicated,
        crossPtyLeaks,
        uncheckedEvictedViews,
        samplesInvalid,
        settleTimeouts,
      },
      samples,
      byDepth: agg.byDepth,
      byCache: agg.byCache,
      byEntryPoint: agg.byEntryPoint,
      weighted: agg.weighted,
      rapid: {
        bursts,
        maxQueueDelayMs: allQueue.length ? Math.max(...allQueue) : NaN,
        maxSettleMs: allSettle.length ? Math.max(...allSettle) : NaN,
        gateOutcomes: rapidGates,
      },
      memory: { checkpoints: { hot, postPurge }, samples: memorySamples },
    };
    if (INCLUDE_MARKS) {
      result.markRecords = readMarks().filter(
        (r) => r.mark.startsWith("project_switch.") || r.mark === SWITCH_MARK.EVENT_LOOP_LAG
      );
    }
    mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    if (fixture && existsSync(fixture.metricsPath)) {
      copyFileSync(fixture.metricsPath, OUTPUT_PATH.replace(/\.json$/, ".marks.ndjson"));
    }
    writeFileSync(
      OUTPUT_PATH,
      JSON.stringify(
        result,
        (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v),
        2
      )
    );

    const row = (
      label: string,
      n: number,
      t: Partial<Record<string, { p50: number; p95: number }>>
    ) =>
      `${label.padEnd(18)} n=${String(n).padStart(3)}  nonce p50/p95=${fmt(t.intentToNoncePaintedMs?.p50)}/${fmt(t.intentToNoncePaintedMs?.p95)}ms  revealed p50/p95=${fmt(t.intentToRevealedMs?.p50)}/${fmt(t.intentToRevealedMs?.p95)}ms  settled p50/p95=${fmt(t.intentToSettledMs?.p50)}/${fmt(t.intentToSettledMs?.p95)}ms`;
    console.log(`──────── project-switch rotation (${LABEL}, cap=${CAP}) ────────`);
    for (const [depth, bucket] of Object.entries(agg.byDepth)) {
      console.log(row(`depth ${depth}`, bucket.n, bucket.timings));
    }
    for (const cache of ["warm", "cold"] as CacheClass[]) {
      console.log(row(cache, agg.byCache[cache].n, agg.byCache[cache].timings));
    }
    for (const [entry, bucket] of Object.entries(agg.byEntryPoint)) {
      console.log(row(entry, bucket.n, bucket.timings));
    }
    console.log(row("weighted", isolated.length, agg.weighted.timings));
    console.log(
      `rapid: bursts=${bursts.length} maxQueueDelay=${fmt(result.rapid.maxQueueDelayMs)}ms maxSettle=${fmt(result.rapid.maxSettleMs)}ms gates=${JSON.stringify(rapidGates)}`
    );
    console.log(
      `memory hot: total=${mb(hot.totalKb)} renderers=${mb(hot.rendererTotalKb)} gpu=${mb(hot.gpuKb)} pty=${mb(hot.ptyDescendantsKb)} views=${hot.views.length} | postPurge: total=${mb(postPurge.totalKb)} renderers=${mb(postPurge.rendererTotalKb)} gpu=${mb(postPurge.gpuKb)} views=${postPurge.views.length}`
    );
    console.log(
      `apparatus: rendererGone=${rendererGone} hardTimeouts=${hardTimeouts} cacheMisclassified=${cacheMisclassified} nonceLost=${nonceLost} nonceDuplicated=${nonceDuplicated} crossPtyLeaks=${crossPtyLeaks} uncheckedEvicted=${uncheckedEvictedViews} invalid=${samplesInvalid} settleTimeouts=${settleTimeouts} fallbacks=${samples.filter((s) => s.entryPointFallback).length} focusRescued=${samples.filter((s) => s.focusRescued).length}`
    );
    console.log(`written: ${OUTPUT_PATH} (${Date.now() - measureStartedAt}ms measured)`);
    console.log("─────────────────────────────────────────────────");

    // Apparatus invariants only — latency, lag and memory are never asserted.
    expect(attachedMismatches, "attached view is the target after every sample").toBe(0);
    expect(rendererGone, "no renderer crashes during measurement").toBe(0);
    // Hard timeouts are a product finding this harness exists to expose; they
    // are reported in `apparatus` and never gate the run.
    expect(
      isolated.flatMap((s) => s.orderingViolations.map((v) => `#${s.index}: ${v}`)),
      "switch marks arrive in causal order"
    ).toEqual([]);
    expect(cacheMisclassified, "cache state matched the MRU model for every sample").toBe(0);
    expect(nonceLost, "every nonce painted in the probe pane").toBe(0);
    expect(nonceDuplicated, "no nonce painted more than once").toBe(0);
    expect(crossPtyLeaks, "no nonce reached another PTY").toBe(0);
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      const valid = isolated.filter(
        (s) => s.depth === depth && Number.isFinite(s.timings.intentToNoncePaintedMs)
      ).length;
      expect(valid, `depth ${depth} produced the requested samples`).toBeGreaterThanOrEqual(
        SAMPLES_PER_DEPTH
      );
    }
    // Every sample's stats feed the aggregate; a NaN-only bucket means the
    // marks the report depends on never arrived.
    expect(
      pct(
        isolated.map((s) => s.timings.intentToNoncePaintedMs),
        50
      )
    ).not.toBeNaN();
  });
});
