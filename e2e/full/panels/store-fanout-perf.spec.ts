/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { tmpdir } from "os";
import { launchApp, closeApp, openSecondWindow, type AppContext } from "../../helpers/launch";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { T_LONG } from "../../helpers/timeouts";

// Store-update fanout harness: how many React components re-render — and how
// many milliseconds of render work run — per git-status tick and per
// agent-state flip, as worktree/panel count scales. Reads per-commit render
// counts and self durations from window.__DAINTREE_RENDER_PROBE__
// (src/utils/renderFanoutProbe.ts), which only exists in a bench build:
//
//   npm run build:e2e:bench
//   RUN_PERF_STORE_FANOUT=1 npx playwright test --project=full-panels \
//     e2e/full/panels/store-fanout-perf.spec.ts
//
// Four workloads per scale, each in a fresh app instance:
//   tick-quiet:  force a git-status poll of one worktree with NO file changes
//   tick-change: dirty/clean a file, then force the poll (real status delta)
//   flip:        drive one agent working<->waiting via a fake claude CLI
//   stream:      one agent streams output for a fixed window (ambient fanout)
//
// Opt-in only — a measurement harness for local A/B runs, never a CI gate
// (perf budgets deliberately stay out of PR CI pre-1.0).
//
// Machines running PARALLEL e2e sessions (agent fleets): every launchApp
// reaps stray e2e Electrons machine-wide via
// `pkill -f "node_modules/electron.*daintree-e2e"`, which kills a long
// benchmark run mid-flight. Immunize this run by pointing it at an Electron
// dist clone outside node_modules (official electron override):
//   cp -Rc node_modules/electron/dist .bench-electron/dist   # APFS clone
//   ELECTRON_OVERRIDE_DIST_PATH=$PWD/.bench-electron/dist RUN_PERF_STORE_FANOUT=1 ...
// Leaked bench apps then need manual cleanup: pkill -f ".bench-electron".
const SCALES = (process.env.PERF_STORE_FANOUT_SCALES ?? "1,5,20,50")
  .split(",")
  .map((s) => Math.max(1, Math.floor(Number(s.trim()))))
  .filter((n) => Number.isFinite(n) && n > 0);
const TICKS = Math.max(3, Math.floor(Number(process.env.PERF_STORE_FANOUT_TICKS) || 15));
const CHANGE_TICKS = Math.max(
  3,
  Math.floor(Number(process.env.PERF_STORE_FANOUT_CHANGE_TICKS) || 10)
);
const FLIP_CYCLES = Math.max(2, Math.floor(Number(process.env.PERF_STORE_FANOUT_FLIP_CYCLES) || 5));
const STREAM_SECONDS = Math.max(
  3,
  Math.floor(Number(process.env.PERF_STORE_FANOUT_STREAM_SECONDS) || 10)
);
const OUT_PATH = process.env.PERF_STORE_FANOUT_OUT ?? "";

const READY_TOKEN = "FAKE_CLAUDE_READY";
const WORK_TOKEN = "__DAINTREE_FAKE_WORK__";
const IDLE_TOKEN = "__DAINTREE_FAKE_IDLE__";

interface EventSample {
  /** commits observed in the event window */
  commits: number;
  /** component fibers rendered across those commits */
  renders: number;
  /** total self render ms across those commits */
  selfMs: number;
  /** per-component rollup for the window */
  byComponent: Record<string, { n: number; ms: number }>;
  /** wall ms from trigger to last attributed commit (diagnostic) */
  windowMs: number;
}

interface WorkloadResult {
  name: string;
  events: EventSample[];
}

interface ScaleResult {
  scale: number;
  panelCount: number;
  ambientCommitsPer10s: number;
  ambientRendersPer10s: number;
  workloads: WorkloadResult[];
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmtRow(name: string, events: EventSample[]): string {
  const renders = events.map((e) => e.renders);
  const selfMs = events.map((e) => e.selfMs);
  const commits = events.map((e) => e.commits);
  return (
    `${name.padEnd(12)} n=${String(events.length).padStart(3)}` +
    ` renders p50=${String(pct(renders, 50)).padStart(5)} p95=${String(pct(renders, 95)).padStart(5)}` +
    ` selfMs p50=${pct(selfMs, 50).toFixed(2).padStart(8)} p95=${pct(selfMs, 95).toFixed(2).padStart(8)}` +
    ` commits p50=${String(pct(commits, 50)).padStart(3)}`
  );
}

function topComponents(
  events: EventSample[],
  limit = 12
): Array<{ name: string; n: number; ms: number }> {
  const merged = new Map<string, { n: number; ms: number }>();
  for (const e of events) {
    for (const [name, v] of Object.entries(e.byComponent)) {
      const entry = merged.get(name) ?? { n: 0, ms: 0 };
      entry.n += v.n;
      entry.ms += v.ms;
      merged.set(name, entry);
    }
  }
  return [...merged.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

interface Fixture {
  dir: string;
  worktreeDirs: string[];
  fakeBinDir: string;
  cleanup: () => void;
}

// Fresh repo + (scale-1) sibling git worktrees + a fake `claude` CLI that
// boots instantly (no trust prompt) and flips working/idle on stdin tokens.
// The OSC 9;4 heartbeat drives the working state viewport-independently
// (#8753); WORK mode also streams a short line every 150ms so the stream
// workload exercises the real output->activity->status-buffer path.
function prepareFixture(scale: number): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), `daintree-e2e-store-fanout-${scale}-`));
  try {
    return buildFixture(scale, dir);
  } catch (error) {
    // A failed git/chmod step would otherwise leak the temp repo and the
    // sibling worktree root.
    rmSync(path.join(path.dirname(dir), path.basename(dir) + "-worktrees"), {
      recursive: true,
      force: true,
    });
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function buildFixture(scale: number, dir: string): Fixture {
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), `# store-fanout-${scale}\n`);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `store-fanout-${scale}`, version: "1.0.0", private: true }, null, 2) +
      "\n"
  );

  const fakeBinDir = path.join(dir, ".e2e-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  const implName = process.platform === "win32" ? "claude.js" : "claude";
  writeFileSync(
    path.join(fakeBinDir, implName),
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      `const WORK = ${JSON.stringify(WORK_TOKEN)};`,
      `const IDLE = ${JSON.stringify(IDLE_TOKEN)};`,
      "const OSC_WORKING = '\\u001b]9;4;1;0\\u0007';",
      "const OSC_IDLE = '\\u001b]9;4;0;0\\u0007';",
      `process.stdout.write('╭─ fake claude ─╮\\n│ fanout bench │\\n╰──────────────╯\\n' + ${JSON.stringify(READY_TOKEN)} + '\\n');`,
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "let oscTimer = null;",
      "let streamTimer = null;",
      "let tick = 0;",
      "const startWork = () => {",
      "  if (oscTimer) return;",
      "  process.stdout.write(OSC_WORKING);",
      "  oscTimer = setInterval(() => process.stdout.write(OSC_WORKING), 1000);",
      "  streamTimer = setInterval(() => {",
      "    tick++;",
      "    process.stdout.write('working... step ' + tick + '\\n');",
      "  }, " + String(Number(process.env.BACKGROUND_ENERGY_STREAM_MS ?? 150)) + ");",
      "};",
      "const stopWork = () => {",
      "  if (oscTimer) { clearInterval(oscTimer); oscTimer = null; }",
      "  if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }",
      "  process.stdout.write(OSC_IDLE);",
      "};",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const shutdown = () => { stopWork(); clearInterval(keepAlive); process.exit(0); };",
      "process.stdin.on('data', (chunk) => {",
      "  const input = String(chunk);",
      "  const wi = input.lastIndexOf(WORK);",
      "  const ii = input.lastIndexOf(IDLE);",
      "  if (wi >= 0 && wi > ii) startWork();",
      "  else if (ii >= 0) stopWork();",
      "});",
      "process.stdin.on('end', shutdown);",
      "process.stdin.on('close', shutdown);",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(path.join(fakeBinDir, implName), 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
    );
  }

  git("add -A", dir);
  git('commit -m "store-fanout fixture"', dir);

  const worktreeRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const worktreeDirs: string[] = [];
  for (let i = 1; i < scale; i++) {
    const branch = `wt-${String(i).padStart(2, "0")}`;
    const wtDir = path.join(worktreeRoot, branch);
    git(`worktree add -b ${branch} ${JSON.stringify(wtDir)} main`, dir);
    worktreeDirs.push(wtDir);
  }

  const cleanup = () => {
    try {
      rmSync(worktreeRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  return { dir, worktreeDirs, fakeBinDir, cleanup };
}

// Exact-value gate: "0"/"false" must not enable a multi-minute benchmark.
const perfDescribe =
  process.env.RUN_PERF_STORE_FANOUT === "1" ? test.describe.serial : test.describe.skip;

perfDescribe("Perf: store-update fanout (renders per git tick / agent flip)", () => {
  const results: ScaleResult[] = [];

  for (const scale of SCALES) {
    test(`fanout at ${scale} worktree(s)`, async () => {
      test.slow();
      test.setTimeout(900_000);

      const fixture = prepareFixture(scale);
      const windowMode = process.env.BACKGROUND_ENERGY_SECOND_WINDOW;
      const secondFixture = windowMode ? prepareFixture(1) : undefined;
      const thirdFixture = windowMode === "1" ? prepareFixture(1) : undefined;
      let ctx: AppContext | undefined;
      try {
        // enableWebgl keeps the GPU process out-of-process (and matches
        // production rendering). The local-macOS default of --disable-gpu
        // --in-process-gpu makes a compositor fault under sustained terminal
        // streaming fatal to the whole app — observed as a mid-flip
        // "graceful shutdown" cascade that killed the measured view.
        ctx = await launchApp({
          enableWebgl: true,
          env: {
            PATH: `${fixture.fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
            DAINTREE_CLI_PATH_PREPEND: fixture.fakeBinDir,
            DAINTREE_IDENTITY_DEBUG_PASS: "1",
          },
        });
        ctx.window = await openAndOnboardProject(
          ctx.app,
          ctx.window,
          fixture.dir,
          `Store Fanout ${scale}`
        );
        const page = ctx.window;

        // The probe only exists in bench builds — fail loudly otherwise.
        const probeState = await page.evaluate(() => {
          const probe = (window as any).__DAINTREE_RENDER_PROBE__;
          return { installed: !!probe?.installed };
        });
        if (process.env.BACKGROUND_ENERGY_PRODUCTION !== "1")
          expect(
            probeState.installed,
            "render probe missing — build with `npm run build:e2e:bench` first"
          ).toBe(true);

        // All worktrees discovered by the workspace scan.
        await expect
          .poll(
            async () =>
              await page.evaluate(async () => {
                const all = await (window as any).electron.worktree.getAll();
                return Array.isArray(all) ? all.length : 0;
              }),
            { timeout: 120_000, intervals: [500, 1000] }
          )
          .toBeGreaterThanOrEqual(scale);

        const worktrees: Array<{ id: string; path: string; isMain: boolean }> = await page.evaluate(
          async () => {
            const all = await (window as any).electron.worktree.getAll();
            return all.map((w: any) => ({
              id: w.id,
              path: w.path,
              isMain: !!(w.isMain ?? w.isMainWorktree),
            }));
          }
        );
        expect(worktrees.length).toBeGreaterThanOrEqual(scale);
        const mainWt = worktrees.find((w) => w.isMain) ?? worktrees[0];

        // Let post-onboarding work (availability probes, pool warmup) settle
        // before the first launch — `agent.launch` returns null while the
        // fake claude hasn't been probed as installed yet.
        await page.waitForTimeout(3_000);

        // One fake agent per worktree. Launches beyond the spawn token bucket
        // (6) queue at 1/s — dispatch sequentially and let the queue drain.
        // Retried because the very first dispatch can race the availability
        // probe on slow starts.
        const launched: string[] = [];
        for (const wt of worktrees.slice(0, scale)) {
          let terminalId: string | null = null;
          for (let attempt = 0; attempt < 20 && !terminalId; attempt++) {
            terminalId = await page.evaluate(async (worktreeId) => {
              const dispatch = (window as any).__daintreeDispatchAction;
              // dispatch returns the ActionDispatchResult envelope, not the
              // action's raw result.
              const envelope = await dispatch(
                "agent.launch",
                { agentId: "claude", worktreeId, focusPolicy: "preserve" },
                { source: "test" }
              );
              return envelope?.ok ? (envelope.result?.terminalId ?? null) : null;
            }, wt.id);
            if (!terminalId) await page.waitForTimeout(1_500);
          }
          expect(terminalId, `agent launch in ${wt.id}`).toBeTruthy();
          launched.push(terminalId!);
        }

        // Deterministic focus across scales: the main worktree is active, so
        // the visible grid panel (and flip target) is always main's agent.
        await page.evaluate((id) => (window as any).electron.worktree.setActive(id), mainWt.id);
        await page.waitForTimeout(1_000);

        // The active worktree's agent is the one we flip; find its grid panel.
        const gridPanel = page.locator('[data-panel-location="grid"]').first();
        await expect(gridPanel).toBeVisible({ timeout: T_LONG });
        const flipPanelId = await gridPanel.getAttribute("data-panel-id");
        expect(flipPanelId).toBeTruthy();

        // Wait for the visible agent to be detected and READY, then let the
        // background spawn queue + availability probes fully settle.
        await expect
          .poll(() => gridPanel.getAttribute("data-detected-agent-id"), {
            timeout: 120_000,
            intervals: [500, 1000],
          })
          .toBe("claude");
        const queueSettleMs = Math.max(5_000, (scale - 6) * 1_100 + 4_000);
        await page.waitForTimeout(queueSettleMs);

        // Reload sentinel: a renderer crash/reload mid-scale reinstalls a fresh
        // probe and silently truncates captured commits — fail loudly instead.
        await page.evaluate(() => {
          (window as any).__FANOUT_SESSION_MARKER__ = true;
        });
        const assertNoReload = async (where: string) => {
          const alive = await page.evaluate(() => !!(window as any).__FANOUT_SESSION_MARKER__);
          expect(alive, `renderer view survived without reload (${where})`).toBe(true);
        };

        const ptyWrite = async (data: string) => {
          await page.evaluate(
            ([id, payload]) => (window as any).electron.terminal.write(id, payload),
            [flipPanelId!, data]
          );
        };

        const probeStart = () =>
          page.evaluate(() => (window as any).__DAINTREE_RENDER_PROBE__?.start());
        const probeStop = () =>
          page.evaluate(() => (window as any).__DAINTREE_RENDER_PROBE__?.stop() ?? []);

        // Attribute captured commits to [t0, t1] windows on the page clock.
        const collectWindow = (
          commits: Array<{ t: number; renders: number; selfMs: number; byComponent: any }>,
          t0: number,
          t1: number
        ): EventSample => {
          const inWindow = commits.filter((c) => c.t >= t0 && c.t <= t1);
          const byComponent: Record<string, { n: number; ms: number }> = {};
          for (const c of inWindow) {
            for (const [name, v] of Object.entries(
              c.byComponent as Record<string, { n: number; ms: number }>
            )) {
              const entry = (byComponent[name] ??= { n: 0, ms: 0 });
              entry.n += v.n;
              entry.ms += v.ms;
            }
          }
          const last = inWindow.length > 0 ? inWindow[inWindow.length - 1].t : t0;
          return {
            commits: inWindow.length,
            renders: inWindow.reduce((a, c) => a + c.renders, 0),
            selfMs: inWindow.reduce((a, c) => a + c.selfMs, 0),
            byComponent,
            windowMs: last - t0,
          };
        };

        // ── Ambient noise floor: 10s with nothing happening ──
        await probeStart();
        await page.waitForTimeout(10_000);
        const ambient = (await probeStop()) as Array<{
          t: number;
          renders: number;
          selfMs: number;
          byComponent: any;
        }>;
        const ambientCommits = ambient.length;
        const ambientRenders = ambient.reduce((a, c) => a + c.renders, 0);

        if (process.env.RUN_BACKGROUND_ENERGY === "1") {
          if (process.env.BACKGROUND_ENERGY_WARM === "1") {
            for (const wt of worktrees.slice(0, scale)) {
              await page.evaluate((id) => (window as any).electron.worktree.setActive(id), wt.id);
              const id = launched[worktrees.indexOf(wt)];
              await expect(
                page.locator(`[data-panel-id="${id}"][data-panel-location="grid"]`)
              ).toBeVisible({ timeout: T_LONG });
              await page.waitForTimeout(250);
            }
            await page.evaluate((id) => (window as any).electron.worktree.setActive(id), mainWt.id);
            await page.waitForTimeout(2000);
          }
          let cachedMirror: Page | undefined;
          let secondActivePage: Page | undefined;
          let mirroredProjectId: string | undefined;
          let cachedIds = launched;
          if (secondFixture) {
            const existingPages = new Set(ctx.app.windows());
            const mirrorMode = windowMode === "mirror";
            let projectId = mirrorMode
              ? await page.evaluate(() => (window as any).__DAINTREE_INITIAL_PROJECT__?.id)
              : undefined;
            await openSecondWindow(ctx.app, page, {
              projectPath: mirrorMode ? fixture.dir : secondFixture.dir,
            });
            if (!mirrorMode) {
              await expect
                .poll(
                  async () => {
                    projectId = await page.evaluate(async (name) => {
                      const all = await (window as any).electron.project.getAll();
                      return all.find((p: any) => p.path.endsWith(name))?.id;
                    }, path.basename(secondFixture.dir));
                    return !!projectId;
                  },
                  { timeout: 30_000 }
                )
                .toBe(true);
            }
            mirroredProjectId = projectId;
            await expect
              .poll(
                async () => {
                  for (const candidate of ctx!.app.windows().filter((p) => !existingPages.has(p))) {
                    if (
                      (await candidate
                        .evaluate(() => (window as any).__DAINTREE_INITIAL_PROJECT__?.id)
                        .catch(() => null)) === projectId
                    )
                      cachedMirror = candidate;
                  }
                  return !!cachedMirror;
                },
                { timeout: 30_000 }
              )
              .toBe(true);
            if (!cachedMirror) throw new Error("Second project view did not attach");
            if (mirrorMode) {
              for (const wt of worktrees.slice(0, scale)) {
                await cachedMirror.evaluate(
                  (id) => (window as any).electron.worktree.setActive(id),
                  wt.id
                );
                const id = launched[worktrees.indexOf(wt)];
                await expect(
                  cachedMirror.locator(`[data-panel-id="${id}"][data-panel-location="grid"]`)
                ).toBeVisible({ timeout: T_LONG });
                await cachedMirror.waitForTimeout(100);
              }
            } else {
              let id: string | null = null;
              await expect
                .poll(
                  async () => {
                    const result = await cachedMirror!.evaluate(async () => {
                      const all = await (window as any).electron.worktree.getAll();
                      if (!all.length) return null;
                      const envelope = await (window as any).__daintreeDispatchAction(
                        "agent.launch",
                        { agentId: "claude", worktreeId: all[0].id, focusPolicy: "preserve" },
                        { source: "test" }
                      );
                      return envelope?.ok ? envelope.result?.terminalId : null;
                    });
                    if (result) id = result;
                    return id;
                  },
                  { timeout: 30_000, intervals: [1500] }
                )
                .toBeTruthy();
              cachedIds = [id!];
              await expect(cachedMirror.locator(`[data-panel-id="${id}"]`)).toBeVisible({
                timeout: T_LONG,
              });
              await expect
                .poll(
                  () =>
                    cachedMirror!
                      .locator(`[data-panel-id="${id}"]`)
                      .getAttribute("data-detected-agent-id"),
                  { timeout: 60_000 }
                )
                .toBe("claude");
            }
            await cachedMirror.evaluate((ids) => {
              const win = window as any;
              win.__energyMirrorCounters = { parsed: 0, renders: 0 };
              for (const id of ids) {
                const terminal = win.__daintreeGetTerminalForE2E(id);
                terminal.onWriteParsed(() => win.__energyMirrorCounters.parsed++);
                terminal.onRender(() => win.__energyMirrorCounters.renders++);
              }
            }, cachedIds);
            secondActivePage = await addAndSwitchToProject(
              ctx.app,
              cachedMirror,
              (thirdFixture ?? secondFixture).dir,
              "Energy second window"
            );
            await cachedMirror.waitForTimeout(2000);
            expect(await cachedMirror.evaluate(() => document.body.dataset.powerSaving)).toBe(
              "true"
            );
            await page.evaluate((id) => (window as any).electron.worktree.setActive(id), mainWt.id);
          }
          const readMirror = () =>
            cachedMirror?.evaluate(() => ({
              ...(window as any).__energyMirrorCounters,
              saving: document.body.dataset.powerSaving,
            }));
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Performance.enable");
          const metrics = async () => {
            const result = await cdp.send("Performance.getMetrics");
            return Object.fromEntries(result.metrics.map((m: any) => [m.name, m.value]));
          };
          await page.evaluate((ids) => {
            const win = window as any;
            win.__energyCounters = {};
            win.__energyCleanup = [];
            win.__energyFlushTerminal = {};
            win.__energyPolicyChanges = [];
            const policyObserver = new MutationObserver(() =>
              win.__energyPolicyChanges.push({
                at: performance.now(),
                saving: document.body.dataset.powerSaving ?? null,
              })
            );
            policyObserver.observe(document.body, {
              attributes: true,
              attributeFilter: ["data-power-saving"],
            });
            win.__energyCleanup.push({ dispose: () => policyObserver.disconnect() });
            for (const id of ids) {
              const terminal = win.__daintreeGetTerminalForE2E(id);
              if (!terminal) continue;
              const counter = {
                parsed: 0,
                renders: 0,
                markers: 0,
                skippedMarkers: 0,
                submittedBytes: 0,
                flushedBytes: 0,
              };
              win.__energyCounters[id] = counter;
              win.__energyCleanup.push(terminal.onWriteParsed(() => counter.parsed++));
              win.__energyCleanup.push(terminal.onRender(() => counter.renders++));
              // Counterfactual apparatus: bounded renderer-only batching, host detection unchanged.
              const originalWrite = terminal.write;
              let pending: Array<{ data: Uint8Array; callback?: () => void }> = [];
              let pendingBytes = 0;
              let previousWriteAt = -Infinity;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const flush = () => {
                if (timer !== undefined) clearTimeout(timer);
                timer = undefined;
                if (!pending.length) return;
                const batch = pending;
                const size = pendingBytes;
                pending = [];
                pendingBytes = 0;
                const bytes = new Uint8Array(size);
                let offset = 0;
                for (const item of batch) {
                  bytes.set(item.data, offset);
                  offset += item.data.length;
                }
                counter.flushedBytes += size;
                originalWrite.call(terminal, bytes, () => {
                  for (const item of batch) item.callback?.();
                });
              };
              win.__energyFlushTerminal[id] = flush;
              terminal.write = function (data: string | Uint8Array, callback?: () => void) {
                const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
                counter.submittedBytes += bytes.length;
                const now = performance.now();
                const frequent = now - previousWriteAt < 60;
                previousWriteAt = now;
                const delay =
                  win.__energyAdaptiveBatch && !frequent ? 0 : (win.__energyBatchMs ?? 0);
                if (!delay || terminal.element?.checkVisibility({ checkVisibilityCSS: true })) {
                  flush();
                  counter.flushedBytes += bytes.length;
                  return originalWrite.call(this, data, callback);
                }
                pending.push({ data: bytes.slice(), callback });
                pendingBytes += bytes.length;
                if (pendingBytes >= 32 * 1024) flush();
                else if (timer === undefined) timer = setTimeout(flush, delay);
              };
              win.__energyCleanup.push({
                dispose: () => {
                  flush();
                  terminal.write = originalWrite;
                },
              });
              const original = terminal.registerMarker;
              terminal.registerMarker = function (...args: any[]) {
                if (
                  win.__energyAblateMarkers &&
                  !terminal.element?.checkVisibility({ checkVisibilityCSS: true })
                ) {
                  counter.skippedMarkers++;
                  return undefined;
                }
                counter.markers++;
                return original.apply(this, args);
              };
              win.__energyCleanup.push({
                dispose: () => {
                  terminal.registerMarker = original;
                },
              });
            }
          }, launched);
          const readCounters = () =>
            page.evaluate(() => {
              const win = window as any;
              return Object.fromEntries(
                Object.entries(win.__energyCounters).map(([id, value]) => {
                  const term = win.__daintreeGetTerminalForE2E(id);
                  return [
                    id,
                    {
                      ...(value as object),
                      paused: term?._core?._renderService?._isPaused,
                      webgl: win.__daintreeGetTerminalWebGLState(id)?.active,
                    },
                  ];
                })
              );
            });
          const readEnergyState = () =>
            page.evaluate(() => ({
              body: { ...document.body.dataset },
              hidden: document.hidden,
              focused: document.hasFocus(),
              reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
              runningSpinners: document
                .getAnimations()
                .filter(
                  (a) =>
                    (a as CSSAnimation).animationName === "spin-slow" && a.playState === "running"
                ).length,
            }));
          const energyWindows = [];
          for (const mode of (process.env.BACKGROUND_ENERGY_MODES ?? "idle,hidden-stream").split(
            ","
          )) {
            if (mode === "hidden-stream") {
              for (const id of launched.filter((id) => id !== flipPanelId)) {
                await page.evaluate(
                  ([id, data]) => (window as any).electron.terminal.write(id, data),
                  [id, `${WORK_TOKEN}\r`]
                );
              }
              if (cachedMirror && windowMode === "1") {
                for (const id of cachedIds)
                  await cachedMirror.evaluate(
                    ([id, data]) => (window as any).electron.terminal.write(id, data),
                    [id, `${WORK_TOKEN}\r`]
                  );
              }
              await page.waitForTimeout(2000);
            }
            await page.evaluate(
              ({ delay, adaptive }) => {
                (window as any).__energyAdaptiveBatch = adaptive;
                for (const flush of Object.values((window as any).__energyFlushTerminal))
                  (flush as () => void)();
                (window as any).__energyBatchMs = delay;
              },
              {
                delay: Number(mode.match(/batch-(\d+)/)?.[1] ?? 0),
                adaptive: mode.includes("adaptive"),
              }
            );
            const pollMatch = mode.match(/poll-(\d+)/);
            if (pollMatch) {
              await page.evaluate(
                ({ ids, interval }) => {
                  for (const id of ids)
                    (window as any).electron.terminal.setActivityTier(id, "active", interval);
                },
                { ids: launched.filter((id) => id !== flipPanelId), interval: Number(pollMatch[1]) }
              );
            }
            await page.evaluate((enabled) => {
              (window as any).__energyAblateMarkers = enabled;
            }, mode.includes("markers-ablated"));
            if (mode.includes("spin-")) {
              await page.evaluate((mode) => {
                document.getElementById("energy-no-motion")?.remove();
                const style = document.createElement("style");
                style.id = "energy-no-motion";
                style.textContent = mode.endsWith("paused")
                  ? ".animate-spin-slow { animation-play-state: paused !important; }"
                  : `.animate-spin-slow { animation-timing-function: steps(${Number(mode.match(/steps-(\d+)/)?.[1] ?? 12)}, end) !important; }`;
                document.head.append(style);
                if (mode.includes("synced")) {
                  for (const a of document.getAnimations()) {
                    if ((a as CSSAnimation).animationName === "spin-slow") a.startTime = 0;
                  }
                }
              }, mode);
            } else if (mode.endsWith("no-motion")) {
              await page.evaluate(() => {
                document.getElementById("energy-no-motion")?.remove();
                const style = document.createElement("style");
                style.id = "energy-no-motion";
                style.textContent =
                  "*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }";
                document.head.append(style);
              });
            } else {
              await page.evaluate(() => document.getElementById("energy-no-motion")?.remove());
            }
            await page.waitForTimeout(2000);
            const animations = await page.evaluate(() =>
              document.getAnimations().map((a) => {
                const target = (a.effect as KeyframeEffect)?.target as Element | null;
                return {
                  state: a.playState,
                  name: (a as CSSAnimation).animationName,
                  tag: target?.tagName,
                  classes: target?.getAttribute("class"),
                  visible: target?.checkVisibility({
                    checkVisibilityCSS: true,
                    contentVisibilityAuto: true,
                  }),
                  ancestors: target
                    ? Array.from(
                        (function* () {
                          let p = target.parentElement;
                          for (let i = 0; p && i < 4; i++, p = p.parentElement) yield p;
                        })()
                      ).map((p) => ({
                        tag: p.tagName,
                        classes: p.className,
                        panel: p.getAttribute("data-panel-id"),
                      }))
                    : [],
                  timing: a.effect?.getComputedTiming(),
                };
              })
            );
            await ctx.app.evaluate(({ app }) => {
              const g = globalThis as any;
              g.__energyCpuSamples = [];
              app.getAppMetrics();
              g.__energyCpuTimer = setInterval(
                () => g.__energyCpuSamples.push(app.getAppMetrics()),
                1000
              );
            });
            if (process.env.BACKGROUND_ENERGY_PROFILE === "1") {
              await cdp.send("Profiler.enable");
              await cdp.send("Profiler.start");
            }
            await probeStart();
            await page.evaluate(() => {
              (window as any).__energyPolicyChanges = [];
            });
            const environmentBefore = await readEnergyState();
            const before = await metrics();
            const countersBefore = await readCounters();
            const mirrorBefore = await readMirror();
            await page.waitForTimeout(Number(process.env.BACKGROUND_ENERGY_WINDOW_MS ?? 10000));
            const after = await metrics();
            const environmentAfter = await readEnergyState();
            const countersAfter = await readCounters();
            const mirrorAfter = await readMirror();
            if (mirrorBefore && mirrorAfter) {
              expect(
                mirrorAfter.renders - mirrorBefore.renders,
                "cached project in another window does not render"
              ).toBe(0);
              expect(mirrorAfter.saving).toBe("true");
              if (windowMode === "1")
                expect(
                  mirrorAfter.parsed - mirrorBefore.parsed,
                  "cached independent project remains current"
                ).toBeGreaterThan(0);
            }
            const commits = await probeStop();
            if (process.env.BACKGROUND_ENERGY_PROFILE === "1") {
              const profile = await cdp.send("Profiler.stop");
              writeFileSync(
                `/tmp/daintree-energy-${scale}-${mode}.cpuprofile`,
                JSON.stringify(profile.profile)
              );
            }
            const processSamples = await ctx.app.evaluate(() => {
              const g = globalThis as any;
              clearInterval(g.__energyCpuTimer);
              return g.__energyCpuSamples;
            });
            console.log("ENERGY_WINDOW_COMPLETE", mode);
            energyWindows.push({
              mode,
              environmentBefore,
              environmentAfter,
              policyChanges: await page.evaluate(() => (window as any).__energyPolicyChanges),
              reactInstrumentation: probeState.installed,
              animations,
              processSamples,
              metrics: Object.fromEntries(
                [
                  "TaskDuration",
                  "ScriptDuration",
                  "LayoutDuration",
                  "RecalcStyleDuration",
                  "LayoutCount",
                  "RecalcStyleCount",
                ].map((key) => [key, after[key] - before[key]])
              ),
              countersBefore,
              countersAfter,
              mirrorBefore,
              mirrorAfter,
              reactCommits: commits.length,
              reactRenders: commits.reduce((n: number, c: any) => n + c.renders, 0),
              topComponents: topComponents([collectWindow(commits, 0, Infinity)]),
            });
          }
          console.log(
            "ENERGY_WINDOWS " + JSON.stringify({ scale, visibleId: flipPanelId, energyWindows })
          );
          const switches = [];
          for (const wt of worktrees.slice(0, scale).filter((wt) => wt.id !== mainWt.id)) {
            const id = launched[worktrees.indexOf(wt)];
            const renderedBefore = await page.evaluate(
              (id) => (window as any).__energyCounters[id].renders,
              id
            );
            const started = Date.now();
            await page.evaluate((id) => (window as any).electron.worktree.setActive(id), wt.id);
            const target = page.locator(`[data-panel-id="${id}"][data-panel-location="grid"]`);
            await expect(target).toBeVisible({ timeout: T_LONG });
            await expect
              .poll(
                () =>
                  page.evaluate((id) => {
                    const terminal = (window as any).__daintreeGetTerminalForE2E(id);
                    if (!terminal) return false;
                    const b = terminal.buffer.active;
                    for (let i = 0; i < b.length; i++) {
                      if (b.getLine(i)?.translateToString().includes("working... step"))
                        return true;
                    }
                    return false;
                  }, id),
                { timeout: T_LONG }
              )
              .toBe(true);
            await expect
              .poll(() => page.evaluate((id) => (window as any).__energyCounters[id].renders, id), {
                timeout: T_LONG,
              })
              .toBeGreaterThan(renderedBefore);
            await expect
              .poll(() => target.getAttribute("data-agent-state"), { timeout: T_LONG })
              .toBe("working");
            const visibleWithOutputMs = Date.now() - started;
            const contents = await page.evaluate((id) => {
              const terminal = (window as any).__daintreeGetTerminalForE2E(id);
              const b = terminal.buffer.active;
              const steps: number[] = [];
              for (let i = 0; i < b.length; i++) {
                const match = b
                  .getLine(i)
                  ?.translateToString(true)
                  .match(/^working\.\.\. step (\d+)$/);
                if (match) steps.push(Number(match[1]));
              }
              return { steps, type: b.type, cols: terminal.cols, rows: terminal.rows };
            }, id);
            expect(contents.steps.length, "streamed numbered output retained").toBeGreaterThan(20);
            const firstGap = contents.steps.findIndex(
              (step, i) => i > 0 && step !== contents.steps[i - 1] + 1
            );
            expect(firstGap, "every retained output line is consecutive").toBe(-1);
            switches.push({
              worktree: wt.id,
              visibleWithOutputMs,
              retainedSteps: contents.steps.length,
              firstStep: contents.steps[0],
              lastStep: contents.steps.at(-1),
            });
          }
          let mirrorRevealMs: number | undefined;
          if (cachedMirror && secondActivePage && mirroredProjectId) {
            for (const id of launched.filter((id) => id !== flipPanelId)) {
              await page.evaluate(
                ([id, data]) => (window as any).electron.terminal.write(id, data),
                [id, `${IDLE_TOKEN}\r`]
              );
            }
            if (windowMode === "1")
              for (const id of cachedIds)
                await cachedMirror.evaluate(
                  ([id, data]) => (window as any).electron.terminal.write(id, data),
                  [id, `${IDLE_TOKEN}\r`]
                );
            await page.waitForTimeout(1000);
            const readLastSteps = (target: Page) =>
              target.evaluate(
                (ids) =>
                  ids.map((id) => {
                    const terminal = (window as any).__daintreeGetTerminalForE2E(id);
                    const buffer = terminal.buffer.active;
                    let last = 0;
                    for (let i = 0; i < buffer.length; i++) {
                      const match = buffer
                        .getLine(i)
                        ?.translateToString(true)
                        .match(/^working\.\.\. step (\d+)$/);
                      if (match) last = Number(match[1]);
                    }
                    return last;
                  }),
                cachedIds.filter((id) => id !== flipPanelId)
              );
            const expectedLastSteps =
              windowMode === "mirror"
                ? await readLastSteps(page)
                : await cachedMirror.evaluate(
                    async (ids) =>
                      Promise.all(
                        ids.map(async (id) => {
                          const snapshot = await (
                            window as any
                          ).electron.terminal.getSerializedState(id);
                          const matches = [
                            ...(snapshot?.data ?? "").matchAll(/working\.\.\. step (\d+)/g),
                          ];
                          return Number(matches.at(-1)?.[1] ?? 0);
                        })
                      ),
                    cachedIds
                  );
            expect(expectedLastSteps.every((step) => step > 20)).toBe(true);
            const started = Date.now();
            await secondActivePage.evaluate((id) => {
              void (window as any).electron.project.switch(id);
            }, mirroredProjectId);
            await expect
              .poll(
                () => cachedMirror!.evaluate(() => (window as any).electron.app.isViewCached()),
                { timeout: T_LONG }
              )
              .toBe(false);
            await expect
              .poll(() => readLastSteps(cachedMirror!), { timeout: T_LONG })
              .toEqual(expectedLastSteps);
            mirrorRevealMs = Date.now() - started;

            // #12557 restored the cached duplicate by keeping the host's IPC
            // fallback open for it while a sibling window's MessagePort took
            // the same chunk. The hazard of that shape is the opposite of the
            // original bug: a view fed on BOTH paths parses every line twice.
            // Matching final step numbers cannot see that, so check the
            // mirror's own buffer for repeated step lines.
            const duplicateIds = cachedIds.filter((id) => id !== flipPanelId);
            // At scale 1 the flip panel IS the only terminal, and an empty
            // sample would make every assertion here vacuously true.
            if (duplicateIds.length > 0) {
              const dupeReport = await cachedMirror.evaluate(
                (ids) =>
                  ids.map((id) => {
                    const terminal = (window as any).__daintreeGetTerminalForE2E(id);
                    const buffer = terminal.buffer.active;
                    // Rejoin wrapped rows first: at a narrow width "step 100"
                    // and "step 101" share a first physical row, which would
                    // read as a duplicate of a line that was never repeated.
                    const logical: string[] = [];
                    for (let i = 0; i < buffer.length; i++) {
                      const line = buffer.getLine(i);
                      if (!line) continue;
                      const text = line.translateToString(true);
                      if (line.isWrapped && logical.length > 0) logical[logical.length - 1] += text;
                      else logical.push(text);
                    }
                    const seen = new Set<string>();
                    let repeated = 0;
                    let matched = 0;
                    for (const text of logical) {
                      const match = text.match(/^working\.\.\. step (\d+)$/);
                      if (!match) continue;
                      matched++;
                      if (seen.has(match[1])) repeated++;
                      else seen.add(match[1]);
                    }
                    return { matched, repeated };
                  }),
                duplicateIds
              );
              // Every terminal must actually hold step lines, or "no duplicates"
              // would just be restating the starvation this fix removed.
              expect(dupeReport.every((r) => r.matched > 0)).toBe(true);
              expect(dupeReport.map((r) => r.repeated)).toEqual(dupeReport.map(() => 0));
            }
          }
          console.log(
            "BACKGROUND_ENERGY " +
              JSON.stringify({
                scale,
                visibleId: flipPanelId,
                energyWindows,
                switches,
                mirrorRevealMs,
              })
          );
          await page.evaluate(() => {
            for (const d of (window as any).__energyCleanup) d.dispose();
          });
          await cdp.detach();
          if (process.env.BACKGROUND_ENERGY_ONLY === "1") return;
          await page.evaluate((id) => (window as any).electron.worktree.setActive(id), mainWt.id);
        }

        // ── Workload: tick-quiet — forced git poll, zero file changes ──
        const tickQuiet: EventSample[] = [];
        await probeStart();
        const quietWindows: Array<{ t0: number; t1: number }> = [];
        for (let k = 0; k < TICKS; k++) {
          const t0 = await page.evaluate(() => performance.now());
          await page.evaluate((id) => (window as any).electron.worktree.refresh(id), mainWt.id);
          await page.waitForTimeout(450);
          const t1 = await page.evaluate(() => performance.now());
          quietWindows.push({ t0, t1 });
        }
        const quietCommits = (await probeStop()) as any[];
        for (const w of quietWindows) tickQuiet.push(collectWindow(quietCommits, w.t0, w.t1));

        // ── Workload: tick-change — alternate dirty/clean, forced poll ──
        const tickChange: EventSample[] = [];
        const churnFile = path.join(mainWt.path, "fanout-churn.txt");
        await probeStart();
        const changeWindows: Array<{ t0: number; t1: number }> = [];
        for (let k = 0; k < CHANGE_TICKS; k++) {
          if (k % 2 === 0) writeFileSync(churnFile, `dirty ${k}\n`);
          else rmSync(churnFile, { force: true });
          const t0 = await page.evaluate(() => performance.now());
          await page.evaluate((id) => (window as any).electron.worktree.refresh(id), mainWt.id);
          await page.waitForTimeout(500);
          const t1 = await page.evaluate(() => performance.now());
          changeWindows.push({ t0, t1 });
        }
        rmSync(churnFile, { force: true });
        const changeCommits = (await probeStop()) as any[];
        for (const w of changeWindows) tickChange.push(collectWindow(changeCommits, w.t0, w.t1));

        // ── Workload: flip — working<->waiting on the visible agent ──
        // waiting->working flips on the first OSC heartbeat (fast);
        // working->waiting rides the ~8s idle debounce. Both directions are
        // bracketed around the observed data-agent-state attribute change.
        const flips: EventSample[] = [];
        // Node-side polling with short evaluates (~±100ms flip-time precision,
        // well within the ±500ms attribution brackets). A single long-running
        // in-page evaluate would die unrecoverably if the view reloads.
        const waitForState = async (state: string, timeoutMs: number): Promise<number> => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const found = await page.evaluate(
              ([panelId, want]) => {
                const el = document.querySelector(`[data-panel-id="${panelId}"]`);
                return el?.getAttribute("data-agent-state") === want ? performance.now() : -1;
              },
              [flipPanelId!, state] as const
            );
            if (found > 0) return found;
            await page.waitForTimeout(100);
          }
          return -1;
        };

        await probeStart();
        const flipWindows: Array<{ t0: number; t1: number; ok: boolean; direction: string }> = [];
        for (let cycle = 0; cycle < FLIP_CYCLES; cycle++) {
          // -> working (fast)
          const tSend = await page.evaluate(() => performance.now());
          await ptyWrite(`${WORK_TOKEN}\r`);
          const tWorking = await waitForState("working", 20_000);
          await page.waitForTimeout(400);
          flipWindows.push({
            t0: tSend,
            t1: tWorking + 400,
            ok: tWorking > 0,
            direction: "working",
          });

          // -> waiting (debounced). Bracket around the observed flip so the
          // ~8s debounce dead-time doesn't pollute the sample.
          await ptyWrite(`${IDLE_TOKEN}\r`);
          const tWaiting = await waitForState("waiting", 40_000);
          await page.waitForTimeout(400);
          flipWindows.push({
            t0: tWaiting - 600,
            t1: tWaiting + 400,
            ok: tWaiting > 0,
            direction: "waiting",
          });
        }
        const flipCommits = (await probeStop()) as any[];
        for (const w of flipWindows) {
          if (w.ok) flips.push(collectWindow(flipCommits, w.t0, w.t1));
        }
        const okWorkingFlips = flipWindows.filter((w) => w.direction === "working" && w.ok).length;
        const okWaitingFlips = flipWindows.filter((w) => w.direction === "waiting" && w.ok).length;

        // ── Workload: stream — one agent streams for STREAM_SECONDS ──
        await ptyWrite(`${WORK_TOKEN}\r`);
        await waitForState("working", 20_000);
        await page.waitForTimeout(1_000);
        await probeStart();
        const streamT0 = await page.evaluate(() => performance.now());
        await page.waitForTimeout(STREAM_SECONDS * 1_000);
        const streamT1 = await page.evaluate(() => performance.now());
        const streamCommits = (await probeStop()) as any[];
        await ptyWrite(`${IDLE_TOKEN}\r`);
        const stream = [collectWindow(streamCommits, streamT0, streamT1)];
        await assertNoReload("after workloads");

        const scaleResult: ScaleResult = {
          scale,
          panelCount: launched.length,
          ambientCommitsPer10s: ambientCommits,
          ambientRendersPer10s: ambientRenders,
          workloads: [
            { name: "tick-quiet", events: tickQuiet },
            { name: "tick-change", events: tickChange },
            { name: "flip", events: flips },
            { name: "stream", events: stream },
          ],
        };
        results.push(scaleResult);

        console.log(`──── store fanout @ ${scale} worktree(s), ${launched.length} agents ────`);
        console.log(`ambient (10s quiet): commits=${ambientCommits} renders=${ambientRenders}`);
        for (const w of scaleResult.workloads) console.log(fmtRow(w.name, w.events));
        for (const w of scaleResult.workloads) {
          const top = topComponents(w.events, 8);
          if (top.length > 0) {
            console.log(
              `top ${w.name}: ` + top.map((t) => `${t.name}×${t.n}(${t.ms.toFixed(1)}ms)`).join(" ")
            );
          }
        }

        // Reliability invariants only — fanout itself is reported, not gated.
        // Per-direction so a failed WORK write can't be masked by the panel
        // already sitting in waiting when the IDLE wait polls it.
        expect(okWorkingFlips, "every ->working flip observed").toBe(FLIP_CYCLES);
        expect(
          okWaitingFlips,
          "->waiting flips observed (one debounce straggler allowed)"
        ).toBeGreaterThanOrEqual(FLIP_CYCLES - 1);
        expect(tickQuiet.length + tickChange.length, "all git ticks completed").toBe(
          TICKS + CHANGE_TICKS
        );
      } finally {
        if (ctx?.app) await closeApp(ctx.app);
        fixture.cleanup();
        secondFixture?.cleanup();
        thirdFixture?.cleanup();
      }
    });
  }

  test.afterAll(() => {
    if (OUT_PATH && results.length > 0) {
      writeFileSync(
        OUT_PATH,
        JSON.stringify(
          {
            scales: SCALES,
            ticks: TICKS,
            changeTicks: CHANGE_TICKS,
            flipCycles: FLIP_CYCLES,
            streamSeconds: STREAM_SECONDS,
            results,
          },
          null,
          2
        )
      );
      console.log(`store-fanout results written to ${OUT_PATH}`);
    }
  });
});
