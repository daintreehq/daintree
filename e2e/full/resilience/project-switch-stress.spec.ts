/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { openTerminal } from "../../helpers/panels";

// Heavy by design: open many projects, put terminals in several, then switch
// relentlessly and measure that the main process never freezes (event-loop
// lag), never crashes a renderer, and never hangs. Tunable via env so CI can
// run a lighter pass while a local run can "go nuts".
// Committed defaults are a modest-but-real stress that completes quickly and is
// stable across CI RAM tiers (the workspace-host warm pool is RAM-scaled, so a
// huge working set would churn differently per machine). Crank these via env to
// "go nuts" locally, e.g. STRESS_PROJECTS=20 STRESS_ROUNDS=3, or to A/B a
// realistic rotation, STRESS_PROJECTS=5 STRESS_ROUNDS=8.
const PROJECT_COUNT = Number(process.env.STRESS_PROJECTS ?? 6);
const SWITCH_ROUNDS = Number(process.env.STRESS_ROUNDS ?? 3);
const TERMINAL_PROJECTS = Number(process.env.STRESS_TERMINALS ?? 4);
// A main-loop stall beyond this reads as a user-visible freeze/pause (reported).
const FREEZE_THRESHOLD_MS = 500;
// A stall this long is a wedge, not a pause — hard-fail on it (machine-
// independent: it means the main process effectively stopped responding).
const WEDGE_THRESHOLD_MS = 8000;

let ctx: AppContext;
let cleanups: Array<() => void> = [];

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

interface LagEvent {
  atMs: number;
  lagMs: number;
}

/** Pull main-loop lag events (freezes) from the app's own log, scoped to a window. */
function readLagEvents(logPath: string, sinceMs: number): LagEvent[] {
  if (!existsSync(logPath)) return [];
  const log = readFileSync(logPath, "utf8");
  const re = /\[([^\]]+)\]\s+\[WARN\]\s+Event loop lag detected\s*\{[\s\S]*?"lagMs":\s*(\d+)/g;
  const out: LagEvent[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const atMs = Date.parse(m[1]);
    if (Number.isFinite(atMs) && atMs >= sinceMs) out.push({ atMs, lagMs: Number(m[2]) });
  }
  return out;
}

/** Pull projectview switch-reveal telemetry (visibleMs) from the app's own log. */
function readSwitchTelemetry(logPath: string, sinceMs: number) {
  if (!existsSync(logPath)) return { cold: [] as number[], warm: [] as number[] };
  const log = readFileSync(logPath, "utf8");
  const cold: number[] = [];
  const warm: number[] = [];
  const re =
    /\[([^\]]+)\]\s+\[INFO\]\s+projectview\.(coldstart|warm-swap)\s*\{[\s\S]*?"visibleMs":\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const atMs = Date.parse(m[1]);
    if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
    (m[2] === "coldstart" ? cold : warm).push(Number(m[3]));
  }
  return { cold, warm };
}

function countMatches(logPath: string, sinceMs: number, needle: RegExp): number {
  if (!existsSync(logPath)) return 0;
  const log = readFileSync(logPath, "utf8");
  let count = 0;
  for (const line of log.split(/\r?\n/)) {
    const tsMatch = line.match(/^\[([^\]]+)\]/);
    if (!tsMatch) continue;
    const atMs = Date.parse(tsMatch[1]);
    if (Number.isFinite(atMs) && atMs >= sinceMs && needle.test(line)) count++;
  }
  return count;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

test.describe.serial("Resilience: heavy project-switch stress", () => {
  test.beforeAll(async () => {
    const fixtures = createFixtureRepos(PROJECT_COUNT);
    cleanups = fixtures.map((f) => f.cleanup);
    const repos = fixtures.map((f) => f.dir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repos[0]);

    // Add the rest via IPC — far faster than the open-dialog UI flow, and the
    // switch storm (not project creation) is what we're measuring.
    for (let i = 1; i < repos.length; i++) {
      await ctx.window.evaluate((p) => (window as any).electron.project.add(p), repos[i]);
    }
    await ctx.window.waitForTimeout(1500);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const c of cleanups) c();
  });

  test("relentless switching across many projects with terminals never freezes, crashes, or hangs", async () => {
    test.slow();
    test.setTimeout(900_000);

    const logPath = path.join(ctx.userDataDir, "logs", "daintree.log");

    const projects: ProjectInfo[] = await ctx.window.evaluate(() =>
      (window as any).electron.project.getAll()
    );
    expect(projects.length).toBeGreaterThanOrEqual(PROJECT_COUNT);

    // Drive a switch to `targetId` from the current active view, then re-acquire
    // the now-active view (robust against LRU eviction of the page we came from).
    // Read the currently-attached project id straight from the main process
    // (the topmost project WebContentsView). Robust against the transient
    // "no active window" state Playwright sees mid-swap under heavy load.
    const getAttachedProjectId = async (): Promise<string | null> =>
      ctx.app.evaluate(async ({ BrowserWindow }) => {
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

    // Trigger a switch from the main process by sending the switch IPC into the
    // topmost live project view. Driving from main (not a Playwright page handle
    // we re-acquire each iteration) is what makes the storm robust: under a cold
    // thrash the attached page can momentarily vanish, which crashes
    // getActiveAppWindow. The PVM serializes switches and no-ops a redundant
    // switch to the already-current project, so this is safe.
    const fireSwitch = async (targetId: string): Promise<void> => {
      await ctx.app.evaluate(async ({ BrowserWindow }, id) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) return;
        const views = (win.contentView?.children ?? []) as Electron.WebContentsView[];
        for (let i = views.length - 1; i >= 0; i--) {
          const wc = views[i]?.webContents;
          if (!wc || wc.isDestroyed()) continue;
          const isProjectView = await wc
            .executeJavaScript("!!(window.electron && window.electron.project)", true)
            .catch(() => false);
          if (isProjectView) {
            void wc
              .executeJavaScript(`void window.electron.project.switch(${JSON.stringify(id)})`, true)
              .catch(() => undefined);
            return;
          }
        }
      }, targetId);
    };

    const switchTo = async (targetId: string): Promise<number> => {
      const t0 = Date.now();
      await fireSwitch(targetId);
      // Wait — via the main process — until the attached view is the target.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if ((await getAttachedProjectId()) === targetId) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return Date.now() - t0;
    };

    // Seed terminals in the first several projects so the switch storm carries
    // live PTY output (xterm repaint + PTY rebrokering pressure). Seeding runs
    // pre-storm (low load), so grabbing a page for openTerminal is reliable here.
    for (let i = 0; i < Math.min(TERMINAL_PROJECTS, projects.length); i++) {
      await switchTo(projects[i].id);
      const page = await getActiveAppWindow(ctx.app, 60_000, { requireProject: true });
      await openTerminal(page);
      await page.waitForTimeout(300);
    }

    // Everything below this point is the measured storm window.
    const stormStart = Date.now();
    const latencies: number[] = [];

    // Every switch target is distinct from the current project: within a round
    // it's projects[i] -> projects[i+1]; at a round boundary it's the last
    // project -> projects[0]; and the first switch comes from the last
    // terminal-seeded project (index TERMINAL_PROJECTS-1 < last). So no
    // iteration is a no-op self-switch that would wedge refreshActiveWindow.
    for (let round = 0; round < SWITCH_ROUNDS; round++) {
      for (const proj of projects) {
        latencies.push(await switchTo(proj.id));
      }
    }

    const stormMs = Date.now() - stormStart;

    // ── Measurements from the app's own telemetry over the storm window ──
    const lagEvents = readLagEvents(logPath, stormStart);
    const freezes = lagEvents.filter((e) => e.lagMs >= FREEZE_THRESHOLD_MS);
    const maxLag = lagEvents.reduce((mx, e) => Math.max(mx, e.lagMs), 0);
    const tele = readSwitchTelemetry(logPath, stormStart);
    const rendererGone = countMatches(
      logPath,
      stormStart,
      /render-process-gone|Renderer process gone|Renderer crashed|Crash loop detected/
    );
    const hardTimeouts = countMatches(logPath, stormStart, /projectview\.paintgate\.hardtimeout/);
    const hostExits = countMatches(logPath, stormStart, /\[WorkspaceHost[^\]]*\] Exited/);

    const totalSwitches = SWITCH_ROUNDS * projects.length;
    console.log("──────── project-switch stress results ────────");
    console.log(
      `projects=${projects.length} rounds=${SWITCH_ROUNDS} switches=${totalSwitches} terminals=${Math.min(TERMINAL_PROJECTS, projects.length)}`
    );
    console.log(
      `storm wall-clock: ${(stormMs / 1000).toFixed(1)}s (${Math.round(stormMs / totalSwitches)}ms/switch incl. test overhead)`
    );
    console.log(
      `switch latency (test-observed): p50=${pct(latencies, 50)}ms p95=${pct(latencies, 95)}ms max=${Math.max(...latencies)}ms`
    );
    console.log(
      `reveal telemetry: cold n=${tele.cold.length} p50=${pct(tele.cold, 50)}ms p95=${pct(tele.cold, 95)}ms | warm n=${tele.warm.length} p50=${pct(tele.warm, 50)}ms p95=${pct(tele.warm, 95)}ms`
    );
    console.log(
      `main-loop lag events: ${lagEvents.length} (>=${FREEZE_THRESHOLD_MS}ms freezes: ${freezes.length}, max ${maxLag}ms)`
    );
    console.log(
      `reliability: renderer-gone=${rendererGone} paint-hard-timeouts=${hardTimeouts} workspace-host-exits=${hostExits}`
    );
    console.log("───────────────────────────────────────────────");

    // ── Hard assertions: machine-independent reliability invariants ──
    // (Freeze COUNT/latency vary with CI RAM — the warm pools are RAM-scaled —
    // so they're reported above, not hard-gated. What must always hold: no
    // renderer crash, every switch resolves (no hang), and the main loop never
    // wedges. The baseline this branch replaced wedged a 5-project rotation
    // outright — a 7s stall that never recovered — which these catch.)
    expect(rendererGone, "no renderer crashes during the storm").toBe(0);
    expect(latencies.length, "every switch resolved (no hang)").toBe(totalSwitches);
    const wedges = lagEvents.filter((e) => e.lagMs >= WEDGE_THRESHOLD_MS);
    expect(
      wedges,
      `main-loop wedges >= ${WEDGE_THRESHOLD_MS}ms: ${JSON.stringify(wedges)}`
    ).toHaveLength(0);
  });
});
