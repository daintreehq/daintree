/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { rmSync, writeFileSync } from "fs";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { T_LONG } from "../helpers/timeouts";
import {
  IDLE_TOKEN,
  TITLE_TOKEN,
  WORK_TOKEN,
  collectWindow,
  launchFanoutApp,
  prepareFixture,
  startFanoutSession,
  topComponents,
  type EventSample,
} from "./fanoutFixture";

// Store-update fanout harness: how many React components re-render — and how
// many milliseconds of render work run — per git-status tick and per
// agent-state flip, as worktree/panel count scales. Reads per-commit render
// counts and self durations from window.__DAINTREE_RENDER_PROBE__
// (src/utils/renderFanoutProbe.ts), which only exists in a bench build:
//
//   npm run build:e2e:bench
//   RUN_PERF_STORE_FANOUT=1 npx playwright test --config=playwright.perf.config.ts \
//     e2e/perf/store-fanout-perf.spec.ts
//
// Workloads per scale, sharing one fresh app instance per scale:
//   tick-quiet:  force a git-status poll of one worktree with NO file changes
//   tick-change: dirty/clean a file, then force the poll (real status delta)
//   flip:        drive one agent working<->waiting via a fake claude CLI
//   stream:      one agent streams output for a fixed window (ambient fanout)
//   flip-fleet:  two idle agents fleet-armed (ribbon shown) while the other
//                agents flip working<->waiting together (3+ agents only)
//   title-fleet: same armed pair while the other agents retitle via OSC 0
//   activity:    main pumps terminal:activity headline changes into the view
//                for every agent at PERF_STORE_FANOUT_ACTIVITY_HZ per pane, so
//                panelStatusBuffer flushes a new panelsById each frame (up to
//                60/s). `stream` never reaches that path: a live agent emits
//                activity only on a state transition, and output-driven
//                activity is for plain shells. Synthetic rate, real renderer
//                path. Reported per 1s window. PERF_STORE_FANOUT_ONLY=activity
//                skips the other workloads (ambient floor still runs).
//   activity-fleet: same pump with the flip-fleet pair armed (3+ agents only);
//                runs last since nothing disarms a fleet
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
const ACTIVITY_SECONDS = Math.max(
  3,
  Math.floor(Number(process.env.PERF_STORE_FANOUT_ACTIVITY_SECONDS) || 10)
);
const ACTIVITY_HZ = Math.min(
  1000,
  Math.max(1, Number(process.env.PERF_STORE_FANOUT_ACTIVITY_HZ) || 10)
);
const ACTIVITY_ONLY = process.env.PERF_STORE_FANOUT_ONLY === "activity";
const OUT_PATH = process.env.PERF_STORE_FANOUT_OUT ?? "";

const SYNTHETIC_HEADLINE = "Fanout synthetic activity";

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
  /** activity workload: headline patches main actually sent per second */
  activitySentPerSec?: number;
  activityFleetSentPerSec?: number;
}

// Components whose per-flush fanout the render PRs (#12998, #12999, #13004,
// #13005, #13008) target; reported by name so a zero is visible, not omitted.
const FANOUT_COMPONENTS = [
  "App",
  "AppInner",
  "AppLayout",
  "ContentGrid",
  "Toolbar",
  "TerminalPane",
  "WorktreeCard",
];
const FLEET_COMPONENT = /^Fleet/;

function namedFanout(events: EventSample[]): string {
  const seconds = events.reduce((a, e) => a + e.windowMs, 0) / 1000 || 1;
  const merged: Record<string, { n: number; ms: number }> = {};
  for (const name of [...FANOUT_COMPONENTS, "Fleet*"]) merged[name] = { n: 0, ms: 0 };
  for (const e of events) {
    for (const [name, v] of Object.entries(e.byComponent)) {
      // Some components are defined as `<Name>Component` and exported under
      // the plain name (TerminalPaneComponent -> TerminalPane).
      const base = name.replace(/Component$/, "");
      const key = FANOUT_COMPONENTS.includes(base)
        ? base
        : FLEET_COMPONENT.test(name)
          ? "Fleet*"
          : null;
      if (!key) continue;
      merged[key].n += v.n;
      merged[key].ms += v.ms;
    }
  }
  return Object.entries(merged)
    .map(([name, v]) => `${name}=${(v.n / seconds).toFixed(1)}/s(${v.ms.toFixed(1)}ms)`)
    .join(" ");
}

function perCommit(events: EventSample[]): string {
  const commits = events.reduce((a, e) => a + e.commits, 0);
  const renders = events.reduce((a, e) => a + e.renders, 0);
  const selfMs = events.reduce((a, e) => a + e.selfMs, 0);
  const seconds = events.reduce((a, e) => a + e.windowMs, 0) / 1000 || 1;
  return (
    `commits/s=${(commits / seconds).toFixed(1)} renders/s=${(renders / seconds).toFixed(0)}` +
    ` selfMs/s=${(selfMs / seconds).toFixed(2)}` +
    ` renders/commit=${commits ? (renders / commits).toFixed(1) : "0"}` +
    ` selfMs/commit=${commits ? (selfMs / commits).toFixed(3) : "0"}`
  );
}

function logScale(result: ScaleResult): void {
  console.log(`──── store fanout @ ${result.scale} worktree(s), ${result.panelCount} agents ────`);
  console.log(
    `ambient (10s quiet): commits=${result.ambientCommitsPer10s} renders=${result.ambientRendersPer10s}`
  );
  for (const w of result.workloads) console.log(fmtRow(w.name, w.events));
  for (const w of result.workloads) {
    const top = topComponents(w.events, 8);
    if (top.length > 0) {
      console.log(
        `top ${w.name}: ` + top.map((t) => `${t.name}×${t.n}(${t.ms.toFixed(1)}ms)`).join(" ")
      );
    }
  }
  for (const [name, sent] of [
    ["activity", result.activitySentPerSec],
    ["activity-fleet", result.activityFleetSentPerSec],
  ] as const) {
    const w = result.workloads.find((x) => x.name === name);
    if (!w) continue;
    console.log(`${name} sent/s=${sent?.toFixed(0)} ${perCommit(w.events)}`);
    console.log(`${name} per-component: ${namedFanout(w.events)}`);
  }
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
      let ctx: AppContext | undefined;
      try {
        ctx = await launchFanoutApp(fixture);
        const {
          page,
          worktrees,
          mainWt,
          launched,
          flipPanelId,
          probeStart,
          probeStop,
          assertNoReload,
        } = await startFanoutSession(ctx, scale, fixture, {
          projectName: `Store Fanout ${scale}`,
          requireProbe: true,
          beforeAgentLaunch: async (page) => {
            // Passive record of each panel's last real activity event, installed
            // before any agent launches, so the activity workload can put every
            // panel back afterwards (and prove its own events arrived).
            await page.evaluate((synthetic) => {
              const win = window as any;
              win.__fanoutLastActivity = {};
              win.electron.terminal.onActivity((payload: any) => {
                if (
                  typeof payload?.headline === "string" &&
                  payload.headline.startsWith(synthetic)
                ) {
                  const delivered = win.__fanoutActivityDelivered;
                  if (delivered)
                    delivered[payload.terminalId] = (delivered[payload.terminalId] ?? 0) + 1;
                } else {
                  win.__fanoutLastActivity[payload.terminalId] = payload;
                }
              });
            }, SYNTHETIC_HEADLINE);
          },
        });

        const ptyWrite = async (data: string) => {
          await page.evaluate(
            ([id, payload]) => (window as any).electron.terminal.write(id, payload),
            [flipPanelId!, data]
          );
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

        // ── Workload: activity — terminal:activity IPC for every agent ──
        // Synthetic events on the production renderer path: main sends them to
        // this view's webContents, then preload -> onActivity listener ->
        // panelStatusBuffer -> one panelsById replacement per rAF. Every patch
        // carries a fresh headline so the buffer's no-op guard never skips it.
        // Paced in main (not via Playwright round trips) at a steady total of
        // agents x ACTIVITY_HZ patches/s. Afterwards each panel gets its last
        // real activity replayed, so later workloads start from the same state.
        const measureActivity = async (): Promise<{
          events: EventSample[];
          sentPerSec: number;
        }> => {
          // Project views share one static URL; the session marker set above
          // exists only in the measured view.
          const viewIds = await ctx!.app.evaluate(async ({ webContents }, url) => {
            const ids: number[] = [];
            for (const wc of webContents.getAllWebContents()) {
              if (wc.isDestroyed() || wc.getURL() !== url) continue;
              if (await wc.executeJavaScript("!!window.__FANOUT_SESSION_MARKER__")) ids.push(wc.id);
            }
            return ids;
          }, page.url());
          expect(viewIds, "activity pump found exactly the measured view").toHaveLength(1);
          await page.evaluate(() => {
            (window as any).__fanoutActivityDelivered = {};
          });
          await ctx!.app.evaluate(
            ({ webContents }, { viewId, ids, rate, headline }) => {
              const wc = webContents.fromId(viewId)!;
              const start = Date.now();
              const pump = {
                sent: 0,
                timer: undefined as ReturnType<typeof setInterval> | undefined,
              };
              pump.timer = setInterval(() => {
                if (wc.isDestroyed()) return;
                const due = Math.floor(((Date.now() - start) / 1000) * rate);
                while (pump.sent < due) {
                  const terminalId = ids[pump.sent % ids.length];
                  pump.sent++;
                  wc.send("terminal:activity", {
                    terminalId,
                    headline: `${headline} ${pump.sent}`,
                    status: "working",
                    type: "interactive",
                    confidence: 1,
                    timestamp: Date.now(),
                  });
                }
              }, 1000 / 60);
              (globalThis as any).__fanoutActivityPump = pump;
            },
            {
              viewId: viewIds[0],
              ids: launched,
              rate: launched.length * ACTIVITY_HZ,
              headline: SYNTHETIC_HEADLINE,
            }
          );
          const stopPump = () =>
            ctx!.app.evaluate(() => {
              const pump = (globalThis as any).__fanoutActivityPump;
              if (!pump) return 0;
              clearInterval(pump.timer);
              (globalThis as any).__fanoutActivityPump = undefined;
              return pump.sent as number;
            });
          try {
            // Settle one second so the first samples start in steady state.
            await page.waitForTimeout(1_000);
            await probeStart();
            const windows: Array<{ t0: number; t1: number }> = [];
            const sentBefore = await ctx!.app.evaluate(
              () => (globalThis as any).__fanoutActivityPump.sent
            );
            const started = Date.now();
            for (let k = 0; k < ACTIVITY_SECONDS; k++) {
              const t0 = await page.evaluate(() => performance.now());
              await page.waitForTimeout(1_000);
              const t1 = await page.evaluate(() => performance.now());
              windows.push({ t0, t1 });
            }
            const commits = (await probeStop()) as any[];
            const sentPerSec = ((await stopPump()) - sentBefore) / ((Date.now() - started) / 1000);
            // windowMs spans the whole 1s window (not trigger->last commit) so
            // per-second rates divide by real time.
            const events = windows.map((w) => ({
              ...collectWindow(commits, w.t0, w.t1),
              windowMs: w.t1 - w.t0,
            }));
            const delivered: Record<string, number> = await page.evaluate(
              () => (window as any).__fanoutActivityDelivered
            );
            expect(
              launched.filter((id) => !delivered[id]),
              "every agent's panel received synthetic activity"
            ).toEqual([]);
            expect(
              events.reduce((a, e) => a + e.commits, 0) / ACTIVITY_SECONDS,
              "activity flushes committed above the ambient commit rate"
            ).toBeGreaterThan(ambientCommits / 10);
            return { events, sentPerSec };
          } finally {
            await stopPump();
            // Replay each panel's last real activity (all-undefined when it
            // never had one, which is what the buffer then writes back).
            const lastReal: Record<string, unknown> = await page.evaluate(
              () => (window as any).__fanoutLastActivity
            );
            await ctx!.app.evaluate(
              ({ webContents }, { viewId, restores }) => {
                const wc = webContents.fromId(viewId);
                if (!wc || wc.isDestroyed()) return;
                for (const payload of restores) wc.send("terminal:activity", payload);
              },
              {
                viewId: viewIds[0],
                restores: launched.map(
                  (terminalId) => lastReal[terminalId] ?? { terminalId, confidence: 1 }
                ),
              }
            );
            // Let the replay flush before any later workload starts.
            await page.waitForTimeout(500);
          }
        };
        const activity = await measureActivity();

        // Two idle agents in side worktrees, armed as a fleet (ribbon + count
        // chip mounted) for flip-fleet, title-fleet and activity-fleet. There
        // is no disarm action, so arming happens only after every unarmed
        // workload has run. Needs 3+ agents.
        const sideIdx = worktrees
          .slice(0, scale)
          .map((wt, i) => (wt.id === mainWt.id ? -1 : i))
          .filter((i) => i >= 0)
          .slice(0, 2);
        const canArmFleet = launched.length >= 3 && sideIdx.length === 2;
        const armSidePair = async () => {
          await page.evaluate(
            (worktreeIds) =>
              (window as any).__daintreeDispatchAction(
                "fleet.armMatchingFilter",
                { worktreeIds },
                { source: "test" }
              ),
            sideIdx.map((i) => worktrees[i].id)
          );
          await expect(page.getByTestId("fleet-arming-ribbon")).toBeVisible({ timeout: T_LONG });
        };

        if (ACTIVITY_ONLY) {
          const workloads: WorkloadResult[] = [{ name: "activity", events: activity.events }];
          let fleetSentPerSec: number | undefined;
          if (canArmFleet) {
            await armSidePair();
            await page.waitForTimeout(1_000);
            const armed = await measureActivity();
            workloads.push({ name: "activity-fleet", events: armed.events });
            fleetSentPerSec = armed.sentPerSec;
          }
          const onlyResult: ScaleResult = {
            scale,
            panelCount: launched.length,
            ambientCommitsPer10s: ambientCommits,
            ambientRendersPer10s: ambientRenders,
            workloads,
            activitySentPerSec: activity.sentPerSec,
            activityFleetSentPerSec: fleetSentPerSec,
          };
          results.push(onlyResult);
          logScale(onlyResult);
          await assertNoReload("after activity");
          return;
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

        // ── Workload: flip-fleet — two idle agents in side worktrees are
        // fleet-armed (ribbon + count chip mounted) while every other agent is
        // driven working->waiting together, so the flips land on panes outside
        // the fleet. One sample per cycle, spanning WORK write to settled
        // waiting. Only the visible (main) agent's transitions are verified;
        // the others are driven by the same writes. Needs 3+ agents; skipped
        // below that.
        const flipFleet: EventSample[] = [];
        const titleFleet: EventSample[] = [];
        if (canArmFleet) {
          const flipIds = launched.filter((_, i) => !sideIdx.includes(i));
          await armSidePair();
          const writeAll = (data: string) =>
            page.evaluate(
              ([ids, payload]) => {
                for (const id of ids as string[])
                  (window as any).electron.terminal.write(id, payload);
              },
              [flipIds, data] as const
            );
          // The stream workload's IDLE rides the ~8s debounce; start from a
          // settled waiting state so the first WORK wait can't pass on the old one.
          await waitForState("waiting", 40_000);
          await page.waitForTimeout(1_000);
          await probeStart();
          const fleetWindows: Array<{ t0: number; t1: number }> = [];
          for (let cycle = 0; cycle < FLIP_CYCLES; cycle++) {
            const t0 = await page.evaluate(() => performance.now());
            await writeAll(`${WORK_TOKEN}\r`);
            const tWorking = await waitForState("working", 20_000);
            await page.waitForTimeout(1_000);
            await writeAll(`${IDLE_TOKEN}\r`);
            const tWaiting = await waitForState("waiting", 40_000);
            await page.waitForTimeout(1_500);
            const t1 = await page.evaluate(() => performance.now());
            if (tWorking > 0 && tWaiting > 0) fleetWindows.push({ t0, t1 });
          }
          const fleetCommits = (await probeStop()) as any[];
          for (const w of fleetWindows) flipFleet.push(collectWindow(fleetCommits, w.t0, w.t1));

          // title-fleet: same armed pair; the other agents retitle themselves
          // (OSC 0, as real agent CLIs do per task) — panel-map writes that
          // change no agent state and touch no armed pane.
          await page.waitForTimeout(1_000);
          await probeStart();
          const titleT0 = await page.evaluate(() => performance.now());
          for (let k = 0; k < TICKS; k++) {
            await writeAll(`${TITLE_TOKEN}Fanout task ${k}\r`);
            await page.waitForTimeout(400);
          }
          await page.waitForTimeout(600);
          const titleT1 = await page.evaluate(() => performance.now());
          const titleCommits = (await probeStop()) as any[];
          titleFleet.push(collectWindow(titleCommits, titleT0, titleT1));
        }
        // activity-fleet: the flip-fleet pair is still armed. Last, so the
        // arming never leaks into an earlier workload.
        const activityFleet = canArmFleet ? await measureActivity() : undefined;
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
            ...(flipFleet.length > 0 ? [{ name: "flip-fleet", events: flipFleet }] : []),
            ...(titleFleet.length > 0 ? [{ name: "title-fleet", events: titleFleet }] : []),
            { name: "activity", events: activity.events },
            ...(activityFleet ? [{ name: "activity-fleet", events: activityFleet.events }] : []),
          ],
          activitySentPerSec: activity.sentPerSec,
          activityFleetSentPerSec: activityFleet?.sentPerSec,
        };
        results.push(scaleResult);
        logScale(scaleResult);

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
            activitySeconds: ACTIVITY_SECONDS,
            activityHz: ACTIVITY_HZ,
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
