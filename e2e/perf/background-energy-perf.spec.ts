/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "os";
import { closeApp, openSecondWindow, type AppContext } from "../helpers/launch";
import { addAndSwitchToProject } from "../helpers/workflows";
import { T_LONG } from "../helpers/timeouts";
import {
  IDLE_TOKEN,
  WORK_TOKEN,
  collectWindow,
  launchFanoutApp,
  prepareFixture,
  startFanoutSession,
  topComponents,
} from "./fanoutFixture";

// Background-terminal energy harness: what hidden worktree terminals cost the
// renderer while they stream, and whether each one still holds every line of
// its output when revealed. One fake claude per worktree (the store-fanout
// fixture); every agent but the visible one streams numbered lines, and each
// measurement window samples CDP Performance metrics, per-terminal xterm
// parse/render counters, app process CPU and (in a bench build) React commits.
// Afterwards every hidden worktree is revealed and its retained output checked
// for consecutive step numbers. Write-up: docs/performance/2026-09-20-energy.md.
//
//   npm run build:e2e:bench        # or build:e2e with BACKGROUND_ENERGY_PRODUCTION=1
//   RUN_BACKGROUND_ENERGY=1 BACKGROUND_ENERGY_SCALES=20 \
//     npx playwright test --config=playwright.perf.config.ts \
//     e2e/perf/background-energy-perf.spec.ts
//
// Knobs:
//   BACKGROUND_ENERGY_SCALES         worktree counts, comma-separated (default 1,5,20,50)
//   BACKGROUND_ENERGY_MODES          window modes in order (default idle,hidden-stream);
//                                    batch-N, adaptive, poll-N, markers-ablated,
//                                    spin-*, no-motion are diagnostic counterfactuals
//   BACKGROUND_ENERGY_WINDOW_MS      length of each measurement window (default 10000)
//   BACKGROUND_ENERGY_STREAM_MS      fake agent output interval (default 150)
//   BACKGROUND_ENERGY_WARM=1         reveal every worktree once before measuring
//   BACKGROUND_ENERGY_SECOND_WINDOW=1  add distinct projects in a second window and
//                                    check the cached one stays current without painting
//   BACKGROUND_ENERGY_PRODUCTION=1   run without the render probe (React counters read 0)
//   BACKGROUND_ENERGY_PROFILE=1      write a renderer CPU profile per window to the OS temp dir
//   BACKGROUND_ENERGY_SPINNER_OVERRIDE=paused  read by launchApp (e2e/helpers/launch.ts)
//
// Opt-in only, like every harness under e2e/perf.
const SCALES = (process.env.BACKGROUND_ENERGY_SCALES ?? "1,5,20,50")
  .split(",")
  .map((s) => Math.max(1, Math.floor(Number(s.trim()))))
  .filter((n) => Number.isFinite(n) && n > 0);
const STREAM_MS = Number(process.env.BACKGROUND_ENERGY_STREAM_MS ?? 150);

// Exact-value gate: "0"/"false" must not enable a multi-minute benchmark.
const energyDescribe =
  process.env.RUN_BACKGROUND_ENERGY === "1" ? test.describe.serial : test.describe.skip;

energyDescribe("Perf: background terminal energy", () => {
  for (const scale of SCALES) {
    test(`background energy at ${scale} worktree(s)`, async () => {
      test.slow();
      test.setTimeout(900_000);

      const windowMode = process.env.BACKGROUND_ENERGY_SECOND_WINDOW;
      // "mirror" opened this same fixture again in a second window. A project
      // has one live view across the app now (#12596) — that open brings the
      // first window forward instead — so the duplicate it measured can't be built.
      // Checked before any fixture is created, which nothing would clean up.
      if (windowMode === "mirror") {
        throw new Error(
          "BACKGROUND_ENERGY_SECOND_WINDOW=mirror is retired: a project can no longer be open in two windows (#12596)"
        );
      }
      const fixture = prepareFixture(scale, STREAM_MS);
      const secondFixture = windowMode ? prepareFixture(1, STREAM_MS) : undefined;
      const thirdFixture = windowMode === "1" ? prepareFixture(1, STREAM_MS) : undefined;
      let ctx: AppContext | undefined;
      try {
        ctx = await launchFanoutApp(fixture);
        const {
          page,
          worktrees,
          mainWt,
          launched,
          flipPanelId,
          probeInstalled,
          probeStart,
          probeStop,
        } = await startFanoutSession(ctx, scale, fixture, {
          projectName: `Background Energy ${scale}`,
          requireProbe: process.env.BACKGROUND_ENERGY_PRODUCTION !== "1",
        });

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
          let projectId: string | undefined;
          await openSecondWindow(ctx.app, page, { projectPath: secondFixture.dir });
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
          {
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
          expect(await cachedMirror.evaluate(() => document.body.dataset.powerSaving)).toBe("true");
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
              motionRate: document.body.dataset.motionRate ?? null,
            })
          );
          policyObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ["data-power-saving", "data-motion-rate"],
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
              const delay = win.__energyAdaptiveBatch && !frequent ? 0 : (win.__energyBatchMs ?? 0);
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
            const profilePath = path.join(tmpdir(), `daintree-energy-${scale}-${mode}.cpuprofile`);
            writeFileSync(profilePath, JSON.stringify(profile.profile));
            console.log("ENERGY_PROFILE", profilePath);
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
            reactInstrumentation: probeInstalled,
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
                    if (b.getLine(i)?.translateToString().includes("working... step")) return true;
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
          const expectedLastSteps = await cachedMirror.evaluate(
            async (ids) =>
              Promise.all(
                ids.map(async (id) => {
                  const snapshot = await (window as any).electron.terminal.getSerializedState(id);
                  const matches = [...(snapshot?.data ?? "").matchAll(/working\.\.\. step (\d+)/g)];
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
            .poll(() => cachedMirror!.evaluate(() => (window as any).electron.app.isViewCached()), {
              timeout: T_LONG,
            })
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
      } finally {
        if (ctx?.app) await closeApp(ctx.app);
        fixture.cleanup();
        secondFixture?.cleanup();
        thirdFixture?.cleanup();
      }
    });
  }
});
