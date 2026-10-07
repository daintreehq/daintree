/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFocusedPanelId } from "../helpers/panels";

// Grid add/close transition benchmark. A worktree grid cycles 4 → 5 → 6 → 5 → 4
// panels — three fake agent TUIs that repaint the whole screen on SIGWINCH,
// like a real agent CLI, plus plain shells — and every transition is driven by
// real input: Cmd+Alt+N to add, the header X (on a middle cell) or Cmd+W to
// close. Each one is recorded frame by frame for a fixed window after the
// input, so the numbers cover the whole transition rather than its first
// frame:
//
//   visibleMs   input → first frame the result shows (new pane with an xterm
//               on screen / closed pane gone)
//   layoutMs    input → last frame any grid cell moved or resized
//   fitMs       input → frame from which every grid xterm stays at the size
//               its container proposes (the grid is settled)
//   promptMs    add only: input → the new shell's prompt is in its buffer
//   jumps       frames in which the cell layout changed (1 is ideal)
//   resizes     frames in which some xterm's cols/rows changed
//   contentMs   input → frame from which every agent TUI has redrawn at its
//               final size too (what the user is waiting to read)
//   agentDraws  full-screen agent redraws (SIGWINCH repaints) in the window
//   loaf*       long animation frames (≥50ms) inside the window
//   gapMs       longest gap between consecutive frames
//
// Opt-in only, never a CI gate:
//   npm run build:e2e
//   RUN_PERF_PANEL_CLOSE_ADD=1 npx playwright test --config=playwright.perf.config.ts \
//     e2e/perf/panel-close-add-perf.spec.ts
// Env: PERF_PCA_CYCLES (default 8), PERF_PCA_OUT (JSON path), PERF_PCA_LABEL,
// PERF_PCA_WINDOW_MS (default 1800), PERF_PCA_WINDOW (default 2560x1440),
// PERF_PCA_PROFILE_DIR (CPU profiles of cycle 1), PERF_PCA_SPINNER=1 (agents
// repaint a status row at 10Hz), PERF_PCA_DEBUG=1 (per-frame dumps),
// PERF_PCA_AGENT_MODE=replay, PERF_PCA_TRANSCRIPT (replay lines, default 3000),
// PERF_PCA_AGENT=codex (settled resize strategy).

const CYCLES = Math.max(2, Math.floor(Number(process.env.PERF_PCA_CYCLES) || 8));
const OUT = process.env.PERF_PCA_OUT ?? "";
const LABEL = process.env.PERF_PCA_LABEL ?? "run";
const WINDOW_MS = Math.max(800, Number(process.env.PERF_PCA_WINDOW_MS) || 1800);
const PROFILE_DIR = process.env.PERF_PCA_PROFILE_DIR ?? "";
const SPINNER = process.env.PERF_PCA_SPINNER === "1";
const DEBUG = process.env.PERF_PCA_DEBUG === "1";
// "screen": alt-screen TUI repainting one screen per SIGWINCH (cheap).
// "replay": main-buffer transcript cleared (ESC[3J) and replayed in full on
// every SIGWINCH, the way Codex redraws — deep scrollback to reflow and parse.
const AGENT_MODE = process.env.PERF_PCA_AGENT_MODE === "replay" ? "replay" : "screen";
// "claude" (default resize strategy) or "codex" (settled strategy).
const AGENT_ID = process.env.PERF_PCA_AGENT === "codex" ? "codex" : "claude";
const TRANSCRIPT_LINES = Math.max(100, Number(process.env.PERF_PCA_TRANSCRIPT) || 3000);
const [WIN_W, WIN_H] = (process.env.PERF_PCA_WINDOW ?? "2560x1440").split("x").map(Number);
const AGENT_READY = "PCA_AGENT_READY";
const PROMPT_TOKEN = "pca%";
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const DWELL_MS = 100;

// Repaints its whole screen at the current size on start and every SIGWINCH —
// the redraw a real agent TUI does when its pane is resized.
const FAKE_AGENT = String.raw`#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log(${JSON.stringify(AGENT_ID === "codex" ? "codex-cli 0.154.0" : "claude code v9.9.9")}); process.exit(0); }
const MODE = ${JSON.stringify(AGENT_MODE)};
const TRANSCRIPT = ${TRANSCRIPT_LINES};
let tick = 0;
let draws = 0;
if (MODE === 'screen') process.stdout.write('\x1b[?1049h');
const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'.split(' ');
const transcript = [];
for (let i = 0; i < TRANSCRIPT; i++) {
  let line = '\x1b[3' + (i % 7 + 1) + 'm' + String(i).padStart(5) + '\x1b[0m ';
  for (let w = 0; w < 6 + (i % 14); w++) line += words[(i * 7 + w) % words.length] + ' ';
  transcript.push(line);
}
const draw = () => {
  draws++;
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const inner = Math.max(0, cols - 2);
  let out;
  if (MODE === 'replay') {
    out = '\x1b[?25l\x1b[H\x1b[2J\x1b[3J' + transcript.join('\r\n') + '\r\n';
    out += '\u256d' + '\u2500'.repeat(inner) + '\u256e\r\n';
    out += '\u2502' + ' > '.padEnd(inner) + '\u2502\r\n';
    out += '\u2570' + '\u2500'.repeat(inner) + '\u256f\r\n';
  } else {
    out = '\x1b[?25l\x1b[H\x1b[2J';
    out += '\u256d' + '\u2500'.repeat(inner) + '\u256e\r\n';
    for (let r = 1; r < rows - 2; r++) {
      const text = (' line ' + r + ' ' + 'lorem ipsum dolor sit amet '.repeat(8)).slice(0, inner);
      out += '\u2502\x1b[3' + (r % 7 + 1) + 'm' + text.padEnd(inner) + '\x1b[0m\u2502\r\n';
    }
    out += '\u2570' + '\u2500'.repeat(inner) + '\u256f\r\n';
  }
  out += '${AGENT_READY} ' + cols + 'x' + rows + ' #' + draws + ' ';
  process.stdout.write(out);
};
draw();
process.stdout.on('resize', draw);
process.stdin.resume();
const keep = setInterval(() => {
  if (!${SPINNER ? "true" : "false"}) return;
  tick++;
  process.stdout.write('\x1b7\x1b[' + ((process.stdout.rows || 24) - 1) + ';2H\x1b[33m' + '|/-\\'[tick % 4] + ' working ' + tick + '\x1b[0m\x1b8');
}, 100);
const stop = () => { clearInterval(keep); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
`;

// Records every frame for `windowMs` after the first trusted input event.
const RECORDER_SOURCE = String.raw`
(() => {
  if (window.__pca) return;
  const epoch = (t) => performance.timeOrigin + t;
  let loafs = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) loafs.push({ s: epoch(e.startTime), d: e.duration, b: e.blockingDuration || 0 });
      if (loafs.length > 400) loafs = loafs.slice(-200);
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {}
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const cells = () => {
    const grid = document.getElementById("panel-grid");
    return grid ? Array.from(grid.children) : [];
  };
  const gridPanelIds = () =>
    Array.from(document.querySelectorAll('[data-panel-location="grid"][data-panel-id]'))
      .filter(visible)
      .map((el) => el.getAttribute("data-panel-id"));
  const snapshot = () => {
    const rects = cells()
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return (el.getAttribute("data-terminal-id") || "?") + "@" + Math.round(r.x) + "," + Math.round(r.y) + "," + Math.round(r.width) + "x" + Math.round(r.height);
      })
      .join("|");
    const ids = gridPanelIds();
    const propose = window.__daintreeProposeTerminalDimensions;
    let dims = "";
    let fit = true;
    for (const id of ids) {
      const d = propose ? propose(id) : null;
      // A pane we cannot measure is not a settled pane.
      if (!d || d.proposedCols <= 0) {
        fit = false;
        dims += id + ":?|";
        continue;
      }
      dims += id + ":" + d.cols + "x" + d.rows + "|";
      if (d.cols !== d.proposedCols || d.rows !== d.proposedRows) fit = false;
    }
    return { rects, dims, fit, ids };
  };
  // Only the tail: reading a deep scrollback every frame would be the cost
  // being measured. No fallback, so every arm pays the same probe.
  const read = (id) => {
    const tail = window.__daintreeReadTerminalTail;
    if (!tail) throw new Error("__daintreeReadTerminalTail missing — rebuild this arm");
    return String(tail(id, 6));
  };
  // Every agent's screen carries the size it last drew at and a draw counter.
  const agentState = (agentIds, token) => {
    const getDims = window.__daintreeGetTerminalDimensions;
    let ok = true;
    let draws = 0;
    const re = new RegExp(token + " (\\d+)x(\\d+) #(\\d+)");
    for (const id of agentIds) {
      const m = re.exec(read(id));
      const d = getDims ? getDims(id) : null;
      if (!m || !d) { ok = false; continue; }
      draws += Number(m[3]);
      if (Number(m[1]) !== d.cols || Number(m[2]) !== d.rows) ok = false;
    }
    return { ok, draws };
  };
  window.__pca = {
    arm(opts) {
      const state = { inputTs: null, inputType: null };
      const baseIds = new Set(Array.from(document.querySelectorAll("[data-panel-id]")).map((e) => e.getAttribute("data-panel-id")));
      const onInput = (e) => {
        if (state.inputTs !== null || !e.isTrusted) return;
        state.inputTs = epoch(e.timeStamp);
        state.inputType = e.type;
      };
      const types = ["pointerdown", "mousedown", "keydown"];
      for (const t of types) window.addEventListener(t, onInput, { capture: true, passive: true });
      const armTs = epoch(performance.now());
      const drawsAtArm = agentState(opts.agentIds, opts.agentToken).draws;
      window.__pcaPending = new Promise((resolve) => {
        const frames = [];
        let prev = snapshot();
        const tick = () => {
          const now = epoch(performance.now());
          if (state.inputTs === null) {
            if (now - armTs > 15000) {
              for (const t of types) window.removeEventListener(t, onInput, { capture: true });
              return resolve({ error: "no input observed" });
            }
            prev = snapshot();
            return requestAnimationFrame(tick);
          }
          const s = snapshot();
          let newId = null;
          for (const id of s.ids) if (!baseIds.has(id)) { newId = id; break; }
          let newXterm = false;
          let prompt = false;
          if (newId) {
            const el = document.querySelector('[data-panel-id="' + newId + '"] .xterm-screen');
            newXterm = visible(el);
            // A fresh shell's prompt sits at the top of a mostly blank
            // viewport, so this reads the (short) whole buffer.
            const whole = window.__daintreeReadTerminalBuffer;
            prompt = !!whole && String(whole(newId)).includes(opts.promptToken);
          }
          let targetGone = false;
          let targetUnmounted = false;
          if (opts.targetId) {
            const els = Array.from(document.querySelectorAll('[data-panel-id="' + opts.targetId + '"]'));
            targetGone = !els.some(visible);
            targetUnmounted = els.length === 0;
          }
          const agents = agentState(opts.agentIds, opts.agentToken);
          frames.push({
            t: now - state.inputTs,
            content: agents.ok,
            draws: agents.draws,
            layout: s.rects !== prev.rects,
            dims: s.dims !== prev.dims,
            fit: s.fit,
            newXterm,
            prompt,
            targetGone,
            targetUnmounted,
            ...(opts.debug ? { rects: s.rects, dimsSig: s.dims } : {}),
          });
          prev = s;
          if (now - state.inputTs < opts.windowMs) return requestAnimationFrame(tick);
          for (const t of types) window.removeEventListener(t, onInput, { capture: true });
          const start = state.inputTs;
          const end = now;
          const agentDraws = agentState(opts.agentIds, opts.agentToken).draws - drawsAtArm;
          // A long frame is reported after it ends; let the last ones land.
          setTimeout(() => {
            const inWin = loafs.filter((l) => l.s + l.d >= start && l.s <= end);
            resolve({ frames, agentDraws, inputType: state.inputType, loafs: inWin.map((l) => ({ s: l.s - start, d: l.d, b: l.b })) });
          }, 150);
        };
        requestAnimationFrame(tick);
      });
      return armTs;
    },
  };
})();
`;

interface Frame {
  t: number;
  content: boolean;
  draws: number;
  layout: boolean;
  dims: boolean;
  fit: boolean;
  newXterm: boolean;
  prompt: boolean;
  targetGone: boolean;
  targetUnmounted: boolean;
}

interface Sample {
  scenario: string;
  cycle: number;
  visibleMs: number | null;
  layoutMs: number | null;
  fitMs: number | null;
  promptMs: number | null;
  unmountMs: number | null;
  contentMs: number | null;
  agentDraws: number;
  jumps: number;
  resizes: number;
  loafCount: number;
  loafMaxMs: number;
  loafBlockingMs: number;
  gapMs: number;
  frames: number;
  settledAtEnd: boolean;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function pctile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

let ctx: AppContext;
let page: Page;
let cleanupFixture: () => void = () => {};
const agentIds = new Set<string>();

async function dispatch(id: string, args?: unknown): Promise<unknown> {
  return page.evaluate(
    ([i, a]) => (window as any).__daintreeDispatchAction(i, a, { source: "user" }),
    [id, args] as const
  );
}

async function gridIds(): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#panel-grid > [data-terminal-id]"))
      .filter((el) => (el as HTMLElement).style.display !== "none")
      .map((el) => el.getAttribute("data-terminal-id") ?? "")
      .filter(Boolean)
  );
}

// Main admits PTY spawns through a leaky bucket (burst 6, then 1/s); reps
// closer together than that would time the guard.
let lastSpawnAt = 0;
async function spawnCooldown(): Promise<void> {
  const wait = lastSpawnAt + 1_200 - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  lastSpawnAt = Date.now();
}

async function idle(ms = 400): Promise<void> {
  await page
    .evaluate(
      () =>
        new Promise<void>((r) => {
          const ric = (window as any).requestIdleCallback;
          if (ric) ric(() => r(), { timeout: 1000 });
          else setTimeout(r, 50);
        })
    )
    .catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function waitForCount(n: number, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await gridIds()).length === n) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`grid never reached ${n} panels (have ${(await gridIds()).length})`);
}

async function record(
  scenario: string,
  cycle: number,
  opts: { targetId?: string },
  trigger: () => Promise<void>
): Promise<Sample> {
  const profiling = PROFILE_DIR && cycle === 1;
  const cdp = profiling ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  await page.evaluate(RECORDER_SOURCE);
  await page.evaluate((o) => (window as any).__pca.arm(o), {
    targetId: opts.targetId,
    windowMs: WINDOW_MS,
    agentIds: [...agentIds],
    agentToken: AGENT_READY,
    promptToken: PROMPT_TOKEN,
    debug: DEBUG,
  });
  await trigger();
  const r: any = await page.evaluate(() => (window as any).__pcaPending);
  if (cdp) {
    const { profile } = await cdp.send("Profiler.stop");
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(
      path.join(PROFILE_DIR, `${LABEL}-${scenario}.cpuprofile`),
      JSON.stringify(profile)
    );
    await cdp.detach();
  }
  if (r.error) throw new Error(`${scenario}: ${r.error}`);
  if (DEBUG && OUT) {
    writeFileSync(
      path.join(path.dirname(OUT), `debug-${LABEL}-${scenario}-${cycle}.json`),
      JSON.stringify(r.frames, null, 1)
    );
  }
  const frames: Frame[] = r.frames;
  const isAdd = !opts.targetId;
  const doneFrame = frames.find((f) => (isAdd ? f.newXterm : f.targetGone));
  const lastLayout = [...frames].reverse().find((f) => f.layout);
  // The frame from which `ok` holds to the end of the window and nothing
  // moves or resizes again — the first frame showing the final state.
  const settledAt = (ok: (f: Frame) => boolean): Frame | undefined => {
    let lastChange = -1;
    frames.forEach((f, i) => {
      if (f.layout || f.dims) lastChange = i;
    });
    let runStart = frames.length;
    for (let i = frames.length - 1; i >= 0 && ok(frames[i]!); i--) runStart = i;
    if (runStart === frames.length) return undefined;
    return frames[Math.max(runStart, lastChange)];
  };
  const done = (f: Frame) => (isAdd ? f.newXterm : f.targetGone);
  // Grid settled: the result shows and every xterm matches its container.
  const fitFrame = settledAt((f) => done(f) && f.fit);
  // Content settled: additionally every agent has redrawn at its final size.
  const contentFrame = settledAt((f) => done(f) && f.fit && f.content);
  const settledAtEnd = fitFrame !== undefined;
  // From the input event, so a stall before the first frame counts.
  let gap = frames[0]?.t ?? 0;
  for (let i = 1; i < frames.length; i++) gap = Math.max(gap, frames[i]!.t - frames[i - 1]!.t);
  const loafs: Array<{ s: number; d: number; b: number }> = r.loafs;
  const promptFrame = frames.find((f) => f.prompt);
  const unmountFrame = frames.find((f) => f.targetUnmounted);
  return {
    scenario,
    cycle,
    visibleMs: doneFrame ? doneFrame.t : null,
    layoutMs: lastLayout ? lastLayout.t : 0,
    fitMs: fitFrame ? fitFrame.t : null,
    promptMs: isAdd ? (promptFrame ? promptFrame.t : null) : null,
    unmountMs: isAdd ? null : unmountFrame ? unmountFrame.t : null,
    contentMs: contentFrame ? contentFrame.t : null,
    agentDraws: r.agentDraws ?? 0,
    jumps: frames.filter((f) => f.layout).length,
    resizes: frames.filter((f) => f.dims).length,
    loafCount: loafs.length,
    loafMaxMs: loafs.reduce((m, l) => Math.max(m, l.d), 0),
    loafBlockingMs: loafs.reduce((m, l) => m + l.b, 0),
    gapMs: gap,
    frames: frames.length,
    settledAtEnd,
  };
}

async function hoverClick(selector: string): Promise<void> {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 10_000 });
  const box = await loc.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(DWELL_MS);
  await page.mouse.down();
  await page.mouse.up();
}

async function addTerminal(scenario: string, cycle: number, expected: number): Promise<Sample> {
  await spawnCooldown();
  const sample = await record(scenario, cycle, {}, () => page.keyboard.press(`${MOD}+Alt+N`));
  await waitForCount(expected);
  return sample;
}

// The middle-most shell: closing it moves every cell after it.
async function pickShell(prefer: "middle" | "first"): Promise<string> {
  const ids = await gridIds();
  const shells = ids.map((id, index) => ({ id, index })).filter((x) => !agentIds.has(x.id));
  if (shells.length === 0) throw new Error("no shell to close");
  if (prefer === "first") return shells[0]!.id;
  const mid = (ids.length - 1) / 2;
  shells.sort((a, b) => Math.abs(a.index - mid) - Math.abs(b.index - mid));
  return shells[0]!.id;
}

async function closeByClick(scenario: string, cycle: number, expected: number): Promise<Sample> {
  const id = await pickShell("middle");
  const sample = await record(scenario, cycle, { targetId: id }, () =>
    hoverClick(`[data-panel-id="${id}"] [data-testid="panel-close"]`)
  );
  await waitForCount(expected);
  return sample;
}

async function closeByKey(scenario: string, cycle: number, expected: number): Promise<Sample> {
  const id = await pickShell("first");
  await page.locator(`[data-panel-id="${id}"] .xterm-screen`).first().click();
  // Cmd+W closes the focused pane; anything else would time the wrong close.
  await expect.poll(() => getFocusedPanelId(page)).toBe(id);
  await idle();
  const sample = await record(scenario, cycle, { targetId: id }, () =>
    page.keyboard.press(`${MOD}+W`)
  );
  await waitForCount(expected);
  return sample;
}

const perfDescribe = process.env.RUN_PERF_PANEL_CLOSE_ADD
  ? test.describe.serial
  : test.describe.skip;

perfDescribe("Perf: grid panel add/close transitions", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const repo = createFixtureRepo({ name: "pca-main", withMultipleFiles: true });
    const shared = mkdtempSync(path.join(tmpdir(), "daintree-e2e-pca-"));
    cleanupFixture = () => {
      repo.cleanup();
      removePathSync(shared);
    };
    const binDir = path.join(shared, "bin");
    mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, AGENT_ID);
    writeFileSync(fake, FAKE_AGENT);
    chmodSync(fake, 0o755);
    const zdotdir = path.join(shared, "zdotdir");
    mkdirSync(zdotdir, { recursive: true });
    writeFileSync(path.join(zdotdir, ".zshrc"), `PROMPT='${PROMPT_TOKEN} '\n`);

    ctx = await launchApp({
      enableWebgl: true,
      windowSize: { width: WIN_W || 2560, height: WIN_H || 1440 },
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: binDir,
        DAINTREE_E2E_SYSTEM_AVAILABLE_MEMORY_MB: "40000",
        ZDOTDIR: zdotdir,
        SHELL: "/bin/zsh",
      },
    });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "pca");
    page = ctx.window;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    cleanupFixture();
  });

  test("add/close cycle", async () => {
    test.setTimeout(30 * 60_000);
    // Three agents and one shell to start: 4 panels.
    for (let i = 0; i < 3; i++) {
      await spawnCooldown();
      const before = new Set(await gridIds());
      await dispatch("agent.launch", { agentId: AGENT_ID, location: "grid" });
      await waitForCount(before.size + 1, 20_000);
      const id = (await gridIds()).find((x) => !before.has(x))!;
      agentIds.add(id);
      await expect
        .poll(
          () =>
            page.evaluate(
              ([pid, token]) =>
                String((window as any).__daintreeReadTerminalBuffer?.(pid) ?? "").includes(token),
              [id, AGENT_READY] as const
            ),
          { timeout: 20_000 }
        )
        .toBe(true);
    }
    await spawnCooldown();
    await dispatch("agent.terminal", { location: "grid" });
    await waitForCount(4);
    await idle(1500);

    const samples: Sample[] = [];
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      samples.push(await addTerminal("add-4to5", cycle, 5));
      await idle();
      samples.push(await addTerminal("add-5to6", cycle, 6));
      await idle();
      samples.push(await closeByClick("close-x-6to5", cycle, 5));
      await idle();
      samples.push(await closeByKey("close-cmdw-5to4", cycle, 4));
      await idle();
      console.log(
        `[pca] cycle ${cycle}: ` +
          samples
            .slice(-4)
            .map(
              (s) =>
                `${s.scenario} vis=${s.visibleMs?.toFixed(0)} fit=${s.fitMs?.toFixed(0)} content=${s.contentMs?.toFixed(0)} draws=${s.agentDraws} jumps=${s.jumps} loaf=${s.loafCount}/${s.loafMaxMs.toFixed(0)}`
            )
            .join(" | ")
      );
    }

    const scenarios = [...new Set(samples.map((s) => s.scenario))];
    const metric = (xs: Sample[], k: keyof Sample) =>
      xs.map((s) => s[k]).filter((v): v is number => typeof v === "number");
    const summary = scenarios.map((sc) => {
      // Cycle 0 is the cold pass (first spawn of the session's chunks).
      const warm = samples.filter((s) => s.scenario === sc && s.cycle > 0);
      const row: Record<string, unknown> = { scenario: sc, n: warm.length };
      for (const k of [
        "visibleMs",
        "layoutMs",
        "fitMs",
        "promptMs",
        "unmountMs",
        "contentMs",
        "agentDraws",
        "jumps",
        "resizes",
        "loafCount",
        "loafMaxMs",
        "loafBlockingMs",
        "gapMs",
      ] as const) {
        const v = metric(warm, k);
        row[`${k}.med`] = median(v);
        row[`${k}.p90`] = pctile(v, 90);
        // Samples that never reached the condition are left out of the
        // percentiles above; count them so they are not silently dropped.
        const applies = !(sc.startsWith("close") ? k === "promptMs" : k === "unmountMs");
        if (applies && v.length < warm.length) row[`${k}.missing`] = warm.length - v.length;
      }
      row.unsettled = warm.filter((s) => !s.settledAtEnd).length;
      return row;
    });
    console.log(`[pca] summary ${LABEL}\n${JSON.stringify(summary, null, 2)}`);
    if (OUT) {
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify({ label: LABEL, summary, samples }, null, 2));
    }
  });
});
