/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_LONG } from "../../helpers/timeouts";

// A/B latency harness for agent-terminal launch. Measures, inside the
// renderer, the time from dispatching `agent.launch` (the exact path the
// toolbar/tray buttons take) to three user-facing milestones:
//   - panel:  the optimistic panel element appears in the grid DOM
//   - xterm:  the xterm element is attached and visible (terminal chrome up)
//   - output: the agent CLI's first output is rendered in the terminal
// A fake `claude` CLI (instant banner + READY token) removes real-CLI boot
// variance so the numbers isolate app overhead. Round 1 is reported as cold
// (first terminal pays lazy imports / pty-pool miss); later rounds as warm.
//
// Opt-in only — a measurement harness for local A/B runs, not a CI gate.
//   RUN_PERF_AGENT_LAUNCH=1 npx playwright test --project=full-terminal \
//     e2e/full/terminal/agent-launch-perf.spec.ts
const ROUNDS = Math.max(1, Math.floor(Number(process.env.PERF_AGENT_LAUNCH_ROUNDS) || 12));
// Idle gap between measured rounds so teardown of one sample (panel close,
// persist flushes, pool re-warm) can't bleed into the next.
const SETTLE_MS = Number(process.env.PERF_AGENT_LAUNCH_SETTLE_MS ?? 750);
const OUT_PATH = process.env.PERF_AGENT_LAUNCH_OUT ?? "";
const READY_TOKEN = "FAKE_AGENT_READY";

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir: string;
let metricsPath: string;
let fixtureCleanup: (() => void) | undefined;

interface RoundSample {
  round: number;
  dispatchResolvedMs: number;
  panelMs: number;
  xtermMs: number;
  firstTextMs: number;
  outputMs: number;
  panelId: string | null;
  error?: string;
}

function prepareFixture(): void {
  const { dir, cleanup } = createFixtureRepo({ name: "agent-launch-perf" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;
  fakeBinDir = path.join(fixtureDir, ".e2e-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  metricsPath = path.join(fixtureDir, "perf-metrics.ndjson");

  const implName = process.platform === "win32" ? "claude.js" : "claude";
  const fakeClaude = path.join(fakeBinDir, implName);
  // Instant-boot fake agent: prints a banner + READY immediately, then idles.
  // No trust prompt — this harness measures app launch overhead, not
  // interaction; CLI boot time is a constant (~node startup) on both variants.
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      // One single write so READY cannot land in a later chunk than the
      // banner — keeps the first-output milestone a single observable event.
      `process.stdout.write('╭─ fake claude ─╮\\n│ benchmarking │\\n╰──────────────╯\\n' + ${JSON.stringify(READY_TOKEN)} + '\\n');`,
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const shutdown = () => { clearInterval(keepAlive); process.exit(0); };",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(fakeClaude, 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
    );
  }

  writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "agent-launch-perf", version: "1.0.0", private: true }, null, 2) + "\n"
  );
  execSync("git add -A && git commit -m agent-launch-perf-fixture", {
    cwd: fixtureDir,
    stdio: "ignore",
  });
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function stats(label: string, arr: number[]): string {
  if (arr.length === 0) return `${label}: n=0`;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return `${label}: n=${arr.length} p50=${pct(arr, 50).toFixed(1)}ms p95=${pct(arr, 95).toFixed(1)}ms mean=${mean.toFixed(1)}ms min=${Math.min(...arr).toFixed(1)}ms max=${Math.max(...arr).toFixed(1)}ms`;
}

const perfDescribe = process.env.RUN_PERF_AGENT_LAUNCH ? test.describe.serial : test.describe.skip;

perfDescribe("Perf: agent-terminal launch latency", () => {
  test.beforeAll(async () => {
    prepareFixture();
    ctx = await launchApp({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
        DAINTREE_IDENTITY_DEBUG_PASS: "1",
        DAINTREE_PERF_CAPTURE: "1",
        DAINTREE_PERF_METRICS_FILE: metricsPath,
      },
    });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Agent Launch Perf");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("measures dispatch → panel → xterm → first-output latency", async () => {
    test.slow();
    test.setTimeout(600_000);
    const { window: page } = ctx;

    // Let post-onboarding work (worktree load, availability probes, pool
    // warmup) settle so round 1 measures launch, not app startup residue.
    await page.waitForTimeout(3_000);

    // Seed the renderer perf-mark consumer buffer: markRendererPerformance
    // records into window.__DAINTREE_PERF_MARKS__ whenever the array exists,
    // independent of the build-time DAINTREE_PERF_CAPTURE gate. Reading the
    // buffer directly avoids depending on the 15s steady-state flush.
    await page.evaluate(() => {
      (window as any).__DAINTREE_PERF_MARKS__ ||= [];
    });

    const measureRound = async (round: number): Promise<RoundSample> => {
      const sample = await page.evaluate(
        async ({ readyToken }) => {
          const gridSel = '[data-panel-location="grid"]';
          const before = new Set(
            Array.from(document.querySelectorAll(gridSel)).map(
              (el) => el.getAttribute("data-panel-id") ?? ""
            )
          );
          const dispatch = (window as any).__daintreeDispatchAction as
            ((id: string, args?: unknown, opts?: unknown) => Promise<unknown>) | undefined;
          if (!dispatch) {
            return {
              dispatchResolvedMs: -1,
              panelMs: -1,
              xtermMs: -1,
              outputMs: -1,
              panelId: null,
              error: "__daintreeDispatchAction missing",
            };
          }

          // Long tasks overlapping the launch window explain paint stalls the
          // milestone marks can't see (commit lands in 1ms; first paint waits
          // out whatever is hogging the main thread).
          const longTasks: Array<{ startMs: number; durMs: number }> = [];
          let observer: PerformanceObserver | undefined;
          try {
            observer = new PerformanceObserver((list) => {
              for (const e of list.getEntries()) {
                longTasks.push({ startMs: e.startTime, durMs: e.duration });
              }
            });
            observer.observe({ type: "longtask", buffered: false });
          } catch {
            // longtask unsupported — probe is best-effort
          }

          const t0 = performance.now();
          let dispatchResolvedMs = -1;
          const dispatched = dispatch(
            "agent.launch",
            { agentId: "claude" },
            { source: "test" }
          ).then(
            (r) => {
              dispatchResolvedMs = performance.now() - t0;
              return r;
            },
            () => {
              dispatchResolvedMs = -2;
              return null;
            }
          );

          let panelMs = -1;
          let xtermMs = -1;
          let firstTextMs = -1;
          let outputMs = -1;
          let panelId: string | null = null;
          const deadline = t0 + 30_000;
          while (performance.now() < deadline) {
            const now = performance.now();
            if (panelId === null) {
              for (const el of Array.from(document.querySelectorAll(gridSel))) {
                const id = el.getAttribute("data-panel-id");
                if (id && !before.has(id)) {
                  panelId = id;
                  panelMs = now - t0;
                  break;
                }
              }
            }
            if (panelId !== null) {
              const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
              if (panelEl) {
                if (xtermMs < 0) {
                  const x = panelEl.querySelector(".xterm");
                  if (x && (x as HTMLElement).clientWidth > 0) xtermMs = now - t0;
                }
                if (xtermMs >= 0 && outputMs < 0) {
                  const rows = panelEl.querySelector(".xterm-rows");
                  const text = rows?.textContent ?? "";
                  if (firstTextMs < 0 && text.trim().length > 0) firstTextMs = now - t0;
                  if (text.includes(readyToken)) {
                    outputMs = now - t0;
                    break;
                  }
                }
              }
            }
            await new Promise((r) => requestAnimationFrame(r));
          }
          await dispatched;
          observer?.disconnect();
          const tasks = longTasks
            .filter((lt) => lt.startMs + lt.durMs >= t0)
            .map((lt) => ({ atMs: Math.round(lt.startMs - t0), durMs: Math.round(lt.durMs) }));
          return { dispatchResolvedMs, panelMs, xtermMs, firstTextMs, outputMs, panelId, tasks };
        },
        { readyToken: READY_TOKEN }
      );

      // Tear down EVERY grid panel — not just the one the sample identified —
      // so a selector miss or a mid-round failure can't leak a running fake
      // agent into later rounds. `confirmed: true` matters: an unconfirmed
      // kill of a running-agent panel doesn't kill — it opens a pending
      // destructive-action confirm that lingers over the app and pollutes
      // subsequent rounds with overlay renders. The close is a fallback for
      // a panel the kill already removed (no-op) or an already-exited agent.
      await page.evaluate(async () => {
        const dispatch = (window as any).__daintreeDispatchAction;
        const ids = Array.from(document.querySelectorAll('[data-panel-location="grid"]'))
          .map((el) => el.getAttribute("data-panel-id"))
          .filter((id): id is string => !!id);
        for (const id of ids) {
          await dispatch?.(
            "terminal.kill",
            { terminalId: id, confirmed: true },
            { source: "test" }
          );
        }
      });
      await expect
        .poll(() => page.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG })
        .toBe(0);

      return { round, ...sample };
    };

    const samples: RoundSample[] = [];
    for (let i = 1; i <= ROUNDS; i++) {
      samples.push(await measureRound(i));
      await page.waitForTimeout(SETTLE_MS);
    }

    // Renderer marks: read the consumer buffer directly. Host (pty-host)
    // marks land in the ndjson file synchronously via fs.appendFileSync.
    const markRecords: unknown[] = await page.evaluate(
      () => (window as any).__DAINTREE_PERF_MARKS__ ?? []
    );
    if (existsSync(metricsPath)) {
      for (const line of readFileSync(metricsPath, "utf8").trim().split("\n")) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (/^(terminal_|pty_pool_|agentlaunch\.)/.test(String(rec.mark))) markRecords.push(rec);
        } catch {
          // Skip lines truncated mid-write.
        }
      }
    }

    const ok = samples.filter((s) => !s.error && s.outputMs >= 0);
    const cold = ok.filter((s) => s.round === 1);
    const warm = ok.filter((s) => s.round > 1);

    console.log("──────── agent-terminal launch latency results ────────");
    console.log(`rounds=${ROUNDS} ok=${ok.length} settleMs=${SETTLE_MS}`);
    for (const s of cold) {
      console.log(
        `cold (round 1): panel=${s.panelMs.toFixed(1)}ms xterm=${s.xtermMs.toFixed(1)}ms output=${s.outputMs.toFixed(1)}ms dispatchResolved=${s.dispatchResolvedMs.toFixed(1)}ms`
      );
    }
    console.log(
      stats(
        "warm dispatch→panel   ",
        warm.map((s) => s.panelMs)
      )
    );
    console.log(
      stats(
        "warm dispatch→xterm   ",
        warm.map((s) => s.xtermMs)
      )
    );
    console.log(
      stats(
        "warm dispatch→output  ",
        warm.map((s) => s.outputMs)
      )
    );
    console.log("────────────────────────────────────────────────────────");

    if (OUT_PATH) {
      writeFileSync(
        OUT_PATH,
        JSON.stringify({ rounds: ROUNDS, settleMs: SETTLE_MS, samples, markRecords }, null, 2)
      );
      console.log(`results written to ${OUT_PATH}`);
    }

    // Reliability invariants only — latency itself is reported, not gated.
    expect(ok.length, "every round produced a rendered agent terminal").toBe(ROUNDS);
    for (const s of samples) {
      expect(s.error ?? "", `round ${s.round} dispatched cleanly`).toBe("");
      expect(
        s.dispatchResolvedMs,
        `round ${s.round} agent.launch dispatch resolved`
      ).toBeGreaterThanOrEqual(0);
      expect(s.panelMs, `round ${s.round} panel appeared`).toBeGreaterThanOrEqual(0);
      expect(s.xtermMs, `round ${s.round} xterm attached`).toBeGreaterThanOrEqual(0);
      expect(s.outputMs, `round ${s.round} agent output rendered`).toBeGreaterThanOrEqual(0);
    }
  });
});
