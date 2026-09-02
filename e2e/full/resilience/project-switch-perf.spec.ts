/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { openTerminal } from "../../helpers/panels";

// A/B latency harness for project switching. Unlike the stress spec (which
// hammers switches to prove the app never wedges), this one measures two
// user-facing latencies per switch, sequentially and gently, so runs are
// comparable across branches:
//   - round-trip: `window.electron.project.switch()` resolve time, measured
//     inside the calling renderer — the full main-process handler including
//     the view swap AND the worktree/git load ("switch fully settled").
//   - reveal: the app's own projectview.coldstart/warm-swap `visibleMs`
//     telemetry — time until the incoming view is actually on screen.
// Cold switches rotate through more projects than the e2e cached-view limit
// (4) so every target was LRU-evicted; warm switches toggle A<->B so the
// target is always cached.
const PROJECT_COUNT = Number(process.env.PERF_SWITCH_PROJECTS ?? 6);
const COLD_ROUNDS = Number(process.env.PERF_SWITCH_COLD_ROUNDS ?? 3);
const WARM_TOGGLES = Number(process.env.PERF_SWITCH_WARM_TOGGLES ?? 12);
const TERMINAL_PROJECTS = Number(process.env.PERF_SWITCH_TERMINALS ?? 2);
// Idle gap between measured switches so deferred post-switch work (LRU
// eviction, persist flushes) from one sample can't bleed into the next.
const SETTLE_MS = 400;
// Optional JSON output for A/B comparison; nothing is written when unset.
const OUTPUT_PATH = process.env.PERF_SWITCH_OUT;
const LABEL = process.env.PERF_SWITCH_LABEL ?? "run";

let ctx: AppContext;
let cleanups: Array<() => void> = [];

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

interface ColdReveal {
  visibleMs: number;
  loadToPaintMs: number;
}

interface ColdInteractive {
  interactiveMs: number;
  loadMs: number;
  visibleMs: number;
  hydrateMs: number;
}

/** Pull projectview reveal telemetry from the app's own log, scoped by time. */
function readRevealTelemetry(logPath: string, sinceMs: number) {
  const cold: ColdReveal[] = [];
  const warm: number[] = [];
  const interactive: ColdInteractive[] = [];
  if (!existsSync(logPath)) return { cold, warm, interactive };
  const log = readFileSync(logPath, "utf8");
  const re =
    /\[([^\]]+)\]\s+\[INFO\]\s+projectview\.(coldstart\.interactive|coldstart|warm-swap)\s*(\{[\s\S]*?\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const atMs = Date.parse(m[1]);
    if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
    let payload: any;
    try {
      payload = JSON.parse(m[3]);
    } catch {
      continue;
    }
    if (m[2] === "coldstart.interactive") {
      if (typeof payload?.interactiveMs !== "number") continue;
      interactive.push({
        interactiveMs: payload.interactiveMs,
        loadMs: typeof payload.loadMs === "number" ? payload.loadMs : NaN,
        visibleMs: typeof payload.visibleMs === "number" ? payload.visibleMs : NaN,
        hydrateMs: typeof payload.hydrateMs === "number" ? payload.hydrateMs : NaN,
      });
      continue;
    }
    if (typeof payload?.visibleMs !== "number") continue;
    if (m[2] === "coldstart") {
      cold.push({
        visibleMs: payload.visibleMs,
        loadToPaintMs: typeof payload.loadToPaintMs === "number" ? payload.loadToPaintMs : NaN,
      });
    } else {
      warm.push(payload.visibleMs);
    }
  }
  return { cold, warm, interactive };
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

function stats(label: string, arr: number[]): string {
  if (arr.length === 0) return `${label}: n=0`;
  return `${label}: n=${arr.length} p50=${pct(arr, 50)}ms p95=${pct(arr, 95)}ms max=${Math.max(...arr)}ms`;
}

function summary(arr: number[]) {
  return {
    n: arr.length,
    p50: arr.length ? pct(arr, 50) : null,
    p95: arr.length ? pct(arr, 95) : null,
    max: arr.length ? Math.max(...arr) : null,
  };
}

// Opt-in only — a measurement harness for local A/B runs, not a CI gate.
// Latency numbers are machine-dependent, so asserting budgets here would
// flake across runners; the assertions below are reliability invariants only.
//   RUN_PERF_SWITCH=1 npx playwright test --project=full-resilience \
//     e2e/full/resilience/project-switch-perf.spec.ts
const perfDescribe =
  process.env.RUN_PERF_SWITCH || process.env.RUN_PERF_STRESS
    ? test.describe.serial
    : test.describe.skip;

perfDescribe("Resilience: project-switch latency measurement", () => {
  test.beforeAll(async () => {
    const fixtures = createFixtureRepos(PROJECT_COUNT);
    cleanups = fixtures.map((f) => f.cleanup);
    const repos = fixtures.map((f) => f.dir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repos[0]);

    for (let i = 1; i < repos.length; i++) {
      await ctx.window.evaluate((p) => (window as any).electron.project.add(p), repos[i]);
    }
    await ctx.window.waitForTimeout(1500);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const c of cleanups) c();
  });

  test("measures cold and warm switch round-trip and reveal latency", async () => {
    test.slow();
    test.setTimeout(600_000);

    const logPath = path.join(ctx.userDataDir, "logs", "daintree.log");

    const projects: ProjectInfo[] = await ctx.window.evaluate(() =>
      (window as any).electron.project.getAll()
    );
    expect(projects.length).toBeGreaterThanOrEqual(PROJECT_COUNT);

    // Read the attached (topmost live) project view's id from the main process.
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

    // Run `project.switch(target)` inside the topmost live project view and
    // time the IPC round-trip in the renderer. Resolves -1 on failure so one
    // bad sample can't hang the harness.
    const timedSwitch = async (targetId: string): Promise<number> => {
      const roundTrip = await ctx.app.evaluate(async ({ BrowserWindow }, id) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) return -1;
        const views = (win.contentView?.children ?? []) as Electron.WebContentsView[];
        for (let i = views.length - 1; i >= 0; i--) {
          const wc = views[i]?.webContents;
          if (!wc || wc.isDestroyed()) continue;
          const isProjectView = await wc
            .executeJavaScript("!!(window.electron && window.electron.project)", true)
            .catch(() => false);
          if (!isProjectView) continue;
          const timeout = new Promise<number>((resolve) => setTimeout(() => resolve(-1), 60_000));
          const run = wc
            .executeJavaScript(
              `(async () => {
                 const t0 = performance.now();
                 await window.electron.project.switch(${JSON.stringify(id)});
                 return Math.round(performance.now() - t0);
               })()`,
              true
            )
            .catch(() => -1) as Promise<number>;
          return Promise.race([run, timeout]);
        }
        return -1;
      }, targetId);

      // The handler resolves after the swap, so the attached view should
      // already be the target; poll briefly to absorb scheduling noise.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if ((await getAttachedProjectId()) === targetId) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return roundTrip;
    };

    const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

    // Seed terminals in the first projects so switches carry PTY restore +
    // warm wake work, matching real usage.
    for (let i = 0; i < Math.min(TERMINAL_PROJECTS, projects.length); i++) {
      await timedSwitch(projects[i].id);
      const page = await getActiveAppWindow(ctx.app, 60_000, { requireProject: true });
      await openTerminal(page);
      await page.waitForTimeout(300);
    }
    await settle();

    // ── Cold phase: rotate through all projects; each target was evicted ──
    const coldStart = Date.now();
    const coldRoundTrips: number[] = [];
    for (let round = 0; round < COLD_ROUNDS; round++) {
      for (const proj of projects) {
        if ((await getAttachedProjectId()) === proj.id) continue;
        coldRoundTrips.push(await timedSwitch(proj.id));
        await settle();
      }
    }
    const coldTele = readRevealTelemetry(logPath, coldStart);

    // ── Warm phase: toggle between the two terminal-seeded projects ──
    const a = projects[0].id;
    const b = projects[1].id;
    await timedSwitch(a);
    await settle();
    await timedSwitch(b);
    await settle();
    const warmStart = Date.now();
    const warmRoundTrips: number[] = [];
    for (let i = 0; i < WARM_TOGGLES; i++) {
      warmRoundTrips.push(await timedSwitch(i % 2 === 0 ? a : b));
      await settle();
    }
    const warmTele = readRevealTelemetry(logPath, warmStart);

    const rendererGone = countMatches(
      logPath,
      coldStart,
      /render-process-gone|Renderer process gone|Renderer crashed|Crash loop detected/
    );
    const hardTimeouts = countMatches(
      logPath,
      coldStart,
      /projectview\.(paintgate|warmpaintgate)\.hardtimeout/
    );

    console.log("──────── project-switch latency results ────────");
    console.log(
      `projects=${projects.length} coldRounds=${COLD_ROUNDS} warmToggles=${WARM_TOGGLES} terminals=${Math.min(TERMINAL_PROJECTS, projects.length)}`
    );
    console.log(
      stats(
        "cold round-trip (switch IPC settled)",
        coldRoundTrips.filter((v) => v >= 0)
      )
    );
    console.log(
      stats(
        "cold reveal (visibleMs)",
        coldTele.cold.map((c) => c.visibleMs)
      )
    );
    console.log(
      stats(
        "cold load->paint gap",
        coldTele.cold.map((c) => c.loadToPaintMs).filter((v) => Number.isFinite(v))
      )
    );
    console.log(
      stats(
        "cold interactive (interactiveMs)",
        coldTele.interactive.map((c) => c.interactiveMs)
      )
    );
    console.log(
      stats(
        "warm round-trip (switch IPC settled)",
        warmRoundTrips.filter((v) => v >= 0)
      )
    );
    console.log(stats("warm reveal (visibleMs)", warmTele.warm));
    console.log(
      `phase telemetry mix: cold-phase cold=${coldTele.cold.length} warm=${coldTele.warm.length} | warm-phase warm=${warmTele.warm.length} cold=${warmTele.cold.length}`
    );
    console.log(`reliability: renderer-gone=${rendererGone} paint-hard-timeouts=${hardTimeouts}`);
    console.log("─────────────────────────────────────────────────");

    if (OUTPUT_PATH) {
      let commit = "unknown";
      try {
        commit = execSync("git rev-parse HEAD", {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        // Not a git checkout; the label still identifies the run.
      }
      mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
      writeFileSync(
        OUTPUT_PATH,
        JSON.stringify(
          {
            label: LABEL,
            commit,
            createdAt: new Date().toISOString(),
            cold: {
              roundTrip: summary(coldRoundTrips.filter((v) => v >= 0)),
              visible: summary(coldTele.cold.map((c) => c.visibleMs)),
              loadToPaint: summary(
                coldTele.cold.map((c) => c.loadToPaintMs).filter((v) => Number.isFinite(v))
              ),
              interactive: summary(coldTele.interactive.map((c) => c.interactiveMs)),
            },
            warm: {
              roundTrip: summary(warmRoundTrips.filter((v) => v >= 0)),
              visible: summary(warmTele.warm),
            },
            reliability: { rendererGone, hardTimeouts },
          },
          null,
          2
        )
      );
      console.log(`written: ${OUTPUT_PATH}`);
    }

    // Reliability invariants only — latency itself is reported, not gated.
    expect(rendererGone, "no renderer crashes during measurement").toBe(0);
    // A paint-gate hard timeout means a switch revealed by falling through its
    // grace period instead of by the renderer's signal — the exact failure
    // mode behind warm swaps stalling at ~1500ms (every warm swap hard-timed-
    // out before the APP_VIEW_WARM_ACTIVATED wake trigger existed). Not a
    // machine-dependent latency budget: on a healthy build this is always 0.
    expect(hardTimeouts, "no paint-gate hard timeouts").toBe(0);
    for (const rt of [...coldRoundTrips, ...warmRoundTrips]) {
      expect(rt, "every measured switch resolved").toBeGreaterThanOrEqual(0);
    }
    // The phases must have exercised the paths they claim to measure.
    expect(coldTele.cold.length, "cold phase produced cold switches").toBeGreaterThanOrEqual(
      Math.floor(COLD_ROUNDS * PROJECT_COUNT * 0.8)
    );
    expect(warmTele.warm.length, "warm phase produced warm switches").toBeGreaterThanOrEqual(
      Math.floor(WARM_TOGGLES * 0.8)
    );
  });
});
