/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { tmpdir } from "os";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, type FixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { openTerminal, getGridPanelIds } from "../../helpers/panels";
import { runTerminalCommand, waitForTerminalReady } from "../../helpers/terminal";

// PERF-120..122 — keystroke-to-paint interactivity benchmark (the integrated
// analogue of PERF-034's headless echo scenario). Measures what a user feels:
// press a key in the focused terminal while the rest of the fleet streams, and
// count the milliseconds until the glyph is painted. The full pipeline
// (keydown → xterm onData → IPC → pty-host → PTY echo → MessagePort → parse →
// paint) is exercised in the real renderer via CDP keyboard input.
//
// Pipeline timestamps (all on the renderer's performance.now() clock):
//   stamp  keydown event creation (event.timeStamp — includes input-queue delay)
//   t0     keydown capture-phase listener runs
//   t1     xterm onData fires (bytes leave the renderer)
//   t4     echo bytes reach terminal.write() (transport complete)
//   t5     parse complete (onWriteParsed) for the confirming chunk
//   t6     first onRender containing the round's sentinel, stamped at next rAF
// Headline metric: t6 - stamp (keystrokePaintMs). Segments are attribution
// aids: inputQueueMs (t0-stamp), inputEncodeMs (t1-t0), ptyRoundTripMs (t4-t1),
// parseMs (t5-t4), paintMs (t6-t5).
//
// Cells:
//   cat-solo        PERF-120  pure tty echo, 0 background — the floor
//   sim-solo        PERF-120  composer-sim (ink-style ~1KB repaint/keystroke), 0 bg
//   sim-fleet       PERF-121  composer-sim + 12 bg terminals × ~32KB/s corpus replay
//   sim-saturation  PERF-122  composer-sim + 6 bg terminals unthrottled (drain-limited)
//
// Opt-in only (multi-minute run, never a CI gate):
//   npm run build:e2e   # or build:e2e:bench
//   RUN_PERF_INTERACTIVITY=1 npx playwright test --project=full-terminal \
//     e2e/full/terminal/interactivity-perf.spec.ts
//
// Machines running PARALLEL e2e sessions: launchApp reaps stray e2e Electrons
// machine-wide (see store-fanout-perf.spec.ts for the ELECTRON_OVERRIDE_DIST_PATH
// immunization recipe).

const ROUNDS = Math.max(10, Math.floor(Number(process.env.PERF_INTERACTIVITY_ROUNDS) || 40));
const WARMUP = Math.max(2, Math.floor(Number(process.env.PERF_INTERACTIVITY_WARMUP) || 8));
const SETTLE_MS = Math.max(50, Math.floor(Number(process.env.PERF_INTERACTIVITY_SETTLE_MS) || 200));
const ROUND_TIMEOUT_MS = Math.max(
  500,
  Math.floor(Number(process.env.PERF_INTERACTIVITY_TIMEOUT_MS) || 2000)
);
const OUT_PATH = process.env.PERF_INTERACTIVITY_OUT ?? "";
const CELL_FILTER = (process.env.PERF_INTERACTIVITY_CELLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Anchor typed before any measured round so expected-text checks never collide
// with shell prompts or box chrome ("==a" is implausible outside the probe).
const ANCHOR = "==";
// 22 distinct chars per batch: type them all, then backspace back to the
// anchor. Backspace rounds are measured too — deletion repaints are part of
// feel. 24 chars total (anchor + batch) keeps the line well below any
// realistic pane width, so the expected string never soft-wraps.
const BATCH_ALPHABET = "abcdefghijklmnopqrstuv";

interface CellDef {
  key: string;
  scenarioId: string;
  workload: "cat" | "composer-sim";
  background: number;
  floodMode: "fleet" | "saturation" | null;
}

const ALL_CELLS: CellDef[] = [
  { key: "cat-solo", scenarioId: "PERF-120", workload: "cat", background: 0, floodMode: null },
  {
    key: "sim-solo",
    scenarioId: "PERF-120",
    workload: "composer-sim",
    background: 0,
    floodMode: null,
  },
  {
    key: "sim-fleet",
    scenarioId: "PERF-121",
    workload: "composer-sim",
    background: 12,
    floodMode: "fleet",
  },
  {
    key: "sim-saturation",
    scenarioId: "PERF-122",
    workload: "composer-sim",
    background: 6,
    floodMode: "saturation",
  },
];

const CELLS =
  CELL_FILTER.length > 0 ? ALL_CELLS.filter((c) => CELL_FILTER.includes(c.key)) : ALL_CELLS;

interface RoundRecord {
  idx: number;
  kind: "type" | "backspace";
  measured: boolean;
  stamp: number | null;
  t0: number | null;
  t1: number | null;
  t4: number | null;
  t5: number | null;
  t6: number | null;
  bytes: number;
  confirmed: boolean;
  timedOut: boolean;
}

interface CellMetrics {
  samples: number;
  timeouts: number;
  keystrokePaintP50Ms: number;
  keystrokePaintP95Ms: number;
  keystrokePaintP99Ms: number;
  keystrokePaintMaxMs: number;
  inputQueueMeanMs: number;
  inputEncodeMeanMs: number;
  ptyRoundTripMeanMs: number;
  parseMeanMs: number;
  paintMeanMs: number;
  repaintBytesPerKeystroke: number;
  frameGapP50Ms: number;
  frameGapP95Ms: number;
  frameGapP99Ms: number;
  frameGapMaxMs: number;
  fpsDuringMeasurement: number;
  loafCount: number;
  loafTotalMs: number;
}

interface CellResult {
  cell: string;
  scenarioId: string;
  workload: string;
  background: number;
  floodMode: string | null;
  rendererMode: string | null;
  dims: { cols: number; rows: number } | null;
  metrics: CellMetrics;
  rounds: RoundRecord[];
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Composer-sim: hermetic ink-style agent composer. Raw-mode stdin; every
// keystroke triggers a deterministic full box repaint (~1KB of ANSI: cursor
// repositioning, borders, accumulated text, SGR-colored status segments) —
// magnitude-faithful to a real agent composer redraw without auth or network.
function composerSimSource(): string {
  return [
    "#!/usr/bin/env node",
    "const out = process.stdout;",
    "const ESC = '\\u001b';",
    "const WIDTH = Math.max(24, Math.min(out.columns || 80, 76));",
    "let text = '';",
    "function statusSegments() {",
    "  let s = '';",
    "  for (let i = 0; i < 36; i++) {",
    "    s += ESC + '[38;5;' + (100 + ((i * 7) % 120)) + 'm' + '\\u2582' + ESC + '[0m';",
    "  }",
    "  return s;",
    "}",
    "function frame() {",
    "  let s = '';",
    "  s += ESC + '[?25l';",
    "  s += '\\r' + ESC + '[3A';",
    "  s += '\\u256d' + '\\u2500'.repeat(WIDTH - 2) + '\\u256e' + ESC + '[K\\n';",
    "  s += '\\u2502 > ' + text + ESC + '[K\\n';",
    "  s += '\\u2570' + '\\u2500'.repeat(WIDTH - 2) + '\\u256f' + ESC + '[K\\n';",
    "  s += '  ' + statusSegments() + ESC + '[2m composer-sim ' + text.length + ' chars' + ESC + '[0m' + ESC + '[K';",
    "  s += ESC + '[?25h';",
    "  out.write(s);",
    "}",
    "out.write('COMPOSER_SIM_READY\\n\\n\\n\\n');",
    "frame();",
    "process.stdin.setRawMode(true);",
    "process.stdin.resume();",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  for (const ch of String(chunk)) {",
    "    if (ch === '\\u0003') { process.stdin.setRawMode(false); process.exit(0); }",
    "    else if (ch === '\\u007f' || ch === '\\b') text = text.slice(0, -1);",
    "    else if (ch >= ' ' && ch !== '\\u007f') text += ch;",
    "  }",
    "  frame();",
    "});",
    "",
  ].join("\n");
}

// Background corpus replay: seeded xorshift32 stream of pseudo agent-log lines
// with SGR color spans, written to stdout at a controlled rate. Bytes traverse
// the real path (pty-host → MessagePort → parse → paint), not synthetic
// renderer writes.
//   fleet:       ~8KB burst every 250ms (~32KB/s) — the "normal busy fleet"
//   saturation:  continuous 16KB chunks, drain-limited — the lockup regime
function corpusReplaySource(): string {
  return [
    "#!/usr/bin/env node",
    "const seed = Number(process.argv[2]) || 1;",
    "const mode = process.argv[3] || 'fleet';",
    "let s = seed >>> 0 || 1;",
    "function rnd() {",
    "  s ^= s << 13; s >>>= 0;",
    "  s ^= s >> 17; s >>>= 0;",
    "  s ^= s << 5; s >>>= 0;",
    "  return s / 4294967296;",
    "}",
    "const ESC = '\\u001b';",
    "const WORDS = ['build', 'parse', 'emit', 'link', 'check', 'trace', 'patch', 'merge', 'scan', 'load'];",
    "function line() {",
    "  const c = 30 + Math.floor(rnd() * 8);",
    "  let l = ESC + '[' + c + 'm[' + Math.floor(rnd() * 100000) + ']' + ESC + '[0m ';",
    "  const n = 8 + Math.floor(rnd() * 6);",
    "  for (let i = 0; i < n; i++) l += WORDS[Math.floor(rnd() * WORDS.length)] + '-' + Math.floor(rnd() * 1000) + ' ';",
    "  return l + '\\n';",
    "}",
    "function chunk(bytes) {",
    "  let out = '';",
    "  while (out.length < bytes) out += line();",
    "  return out;",
    "}",
    "if (mode === 'saturation') {",
    "  const pump = () => { while (process.stdout.write(chunk(16384))) {} };",
    "  process.stdout.on('drain', pump);",
    "  pump();",
    "} else {",
    "  setInterval(() => { process.stdout.write(chunk(8192)); }, 250);",
    "}",
    "",
  ].join("\n");
}

interface RoundSpec {
  idx: number;
  kind: "type" | "backspace";
  measured: boolean;
  expectKey: string;
  expectData: string;
  expectText: string;
  forbidText: string | null;
}

// Deterministic round sequence: type the batch alphabet onto the anchor, then
// backspace it off, repeating until enough measured rounds exist. The expected
// buffer text after every round is exact, so paint confirmation is unambiguous.
function buildRounds(total: number): RoundSpec[] {
  const rounds: RoundSpec[] = [];
  let accumulated = "";
  let idx = 0;
  while (rounds.length < total) {
    for (const ch of BATCH_ALPHABET) {
      if (rounds.length >= total) break;
      const next = accumulated + ch;
      rounds.push({
        idx: idx++,
        kind: "type",
        measured: true,
        expectKey: ch,
        expectData: ch,
        expectText: ANCHOR + next,
        forbidText: null,
      });
      accumulated = next;
    }
    while (accumulated.length > 0 && rounds.length < total) {
      const shorter = accumulated.slice(0, -1);
      rounds.push({
        idx: idx++,
        kind: "backspace",
        measured: true,
        expectKey: "Backspace",
        expectData: "",
        expectText: ANCHOR + shorter,
        forbidText: ANCHOR + accumulated,
      });
      accumulated = shorter;
    }
  }
  for (let i = 0; i < Math.min(WARMUP, rounds.length); i++) rounds[i].measured = false;
  return rounds;
}

async function installProbe(page: any, panelId: string): Promise<void> {
  await page.evaluate((id: string) => {
    const term = (window as any).__daintreeGetTerminalForE2E?.(id);
    if (!term) throw new Error(`interactivity probe: no terminal for panel ${id}`);
    const probe: any = {
      rounds: [],
      current: null,
      disposed: false,
      frame: { gaps: [], last: 0, rafId: 0 },
      loaf: { count: 0, totalMs: 0, max: 0 },
    };
    const onKeydown = (e: KeyboardEvent) => {
      const c = probe.current;
      if (!c || c.t0 !== null) return;
      if (e.key === c.expectKey) {
        c.t0 = performance.now();
        c.stamp = e.timeStamp;
      }
    };
    window.addEventListener("keydown", onKeydown, true);
    const d1 = term.onData((d: string) => {
      const c = probe.current;
      if (c && c.t0 !== null && c.t1 === null && d === c.expectData) c.t1 = performance.now();
    });
    const origWrite = term.write.bind(term);
    term.write = (data: any, cb?: () => void) => {
      const c = probe.current;
      if (c && c.t1 !== null && !c.confirmed) {
        if (c.t4 === null) c.t4 = performance.now();
        c.bytes += typeof data === "string" ? data.length : (data?.length ?? 0);
      }
      return origWrite(data, cb);
    };
    const d2 = term.onWriteParsed(() => {
      const c = probe.current;
      if (c && c.t4 !== null && !c.confirmed) c.t5 = performance.now();
    });
    const regionText = () => {
      const buf = term.buffer.active;
      const cursorAbs = buf.baseY + buf.cursorY;
      const lo = Math.max(0, cursorAbs - 5);
      const hi = Math.min(buf.length - 1, cursorAbs + 1);
      const rows: string[] = [];
      for (let i = lo; i <= hi; i++) {
        const line = buf.getLine(i);
        if (line) rows.push(line.translateToString(true));
      }
      return rows.join("\n");
    };
    const isConfirmedNow = () => {
      const c = probe.current;
      if (!c) return false;
      const text = regionText();
      if (!text.includes(c.expectText)) return false;
      if (c.forbidText && text.includes(c.forbidText)) return false;
      return true;
    };
    const d3 = term.onRender(() => {
      const c = probe.current;
      if (!c || c.confirmed || c.t4 === null) return;
      if (!isConfirmedNow()) return;
      c.confirmed = true;
      requestAnimationFrame((ts) => {
        c.t6 = ts;
        c.done = true;
      });
    });
    const loop = (ts: number) => {
      if (probe.disposed) return;
      if (probe.frame.last > 0) probe.frame.gaps.push(ts - probe.frame.last);
      probe.frame.last = ts;
      probe.frame.rafId = requestAnimationFrame(loop);
    };
    probe.frame.rafId = requestAnimationFrame(loop);
    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          probe.loaf.count++;
          probe.loaf.totalMs += entry.duration;
          if (entry.duration > probe.loaf.max) probe.loaf.max = entry.duration;
        }
      });
      po.observe({ type: "long-animation-frame", durationThreshold: 50 } as any);
    } catch {
      po = null;
    }
    probe.begin = (spec: any): boolean => {
      probe.current = {
        idx: spec.idx,
        kind: spec.kind,
        measured: spec.measured,
        expectKey: spec.expectKey === "Backspace" ? "Backspace" : spec.expectKey,
        expectData: spec.expectData,
        expectText: spec.expectText,
        forbidText: spec.forbidText ?? null,
        stamp: null,
        t0: null,
        t1: null,
        t4: null,
        t5: null,
        t6: null,
        bytes: 0,
        confirmed: false,
        done: false,
      };
      const ae = document.activeElement as HTMLElement | null;
      return (
        !!ae?.classList.contains("xterm-helper-textarea") && !!ae.closest(`[data-panel-id="${id}"]`)
      );
    };
    probe.finish = (timedOut: boolean) => {
      const c = probe.current;
      probe.current = null;
      if (!c) return;
      probe.rounds.push({
        idx: c.idx,
        kind: c.kind,
        measured: c.measured,
        stamp: c.stamp,
        t0: c.t0,
        t1: c.t1,
        t4: c.t4,
        t5: c.t5,
        t6: c.t6,
        bytes: c.bytes,
        confirmed: c.confirmed,
        timedOut,
      });
    };
    probe.isDone = () => !!(probe.current && probe.current.done);
    probe.resetPacing = () => {
      probe.frame.gaps = [];
      probe.frame.last = 0;
      probe.loaf = { count: 0, totalMs: 0, max: 0 };
    };
    probe.snapshot = () => ({
      rounds: probe.rounds,
      frameGaps: probe.frame.gaps,
      loaf: probe.loaf,
    });
    probe.dispose = () => {
      probe.disposed = true;
      cancelAnimationFrame(probe.frame.rafId);
      window.removeEventListener("keydown", onKeydown, true);
      d1.dispose();
      d2.dispose();
      d3.dispose();
      term.write = origWrite;
      po?.disconnect();
    };
    (window as any).__DAINTREE_INTERACTIVITY_PROBE__ = probe;
  }, panelId);
}

async function focusMeasuredPane(page: any, panelId: string): Promise<void> {
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await panel
    .locator(".xterm")
    .first()
    .click({ position: { x: 30, y: 10 } });
  await expect
    .poll(
      () =>
        page.evaluate((id: string) => {
          const ae = document.activeElement as HTMLElement | null;
          return (
            !!ae?.classList.contains("xterm-helper-textarea") &&
            !!ae.closest(`[data-panel-id="${id}"]`)
          );
        }, panelId),
      { timeout: 10_000, intervals: [100, 250, 500] }
    )
    .toBe(true);
}

// One paced round: begin bookkeeping, dispatch a real CDP keystroke, wait for
// paint confirmation (or timeout), settle while the flood keeps running.
async function runRound(page: any, panelId: string, spec: RoundSpec): Promise<void> {
  const focused = await page.evaluate(
    (s: any) => (window as any).__DAINTREE_INTERACTIVITY_PROBE__.begin(s),
    spec as any
  );
  if (!focused) await focusMeasuredPane(page, panelId);
  if (spec.kind === "backspace") await page.keyboard.press("Backspace");
  else await page.keyboard.type(spec.expectKey);
  try {
    await page.waitForFunction(
      () => (window as any).__DAINTREE_INTERACTIVITY_PROBE__.isDone(),
      undefined,
      { timeout: ROUND_TIMEOUT_MS, polling: "raf" }
    );
    await page.evaluate(() => (window as any).__DAINTREE_INTERACTIVITY_PROBE__.finish(false));
  } catch {
    await page.evaluate(() => (window as any).__DAINTREE_INTERACTIVITY_PROBE__.finish(true));
  }
  await page.waitForTimeout(SETTLE_MS);
}

function computeMetrics(
  rounds: RoundRecord[],
  frameGaps: number[],
  loaf: { count: number; totalMs: number; max: number }
): CellMetrics {
  const measured = rounds.filter((r) => r.measured);
  const ok = measured.filter((r) => !r.timedOut && r.t6 !== null && (r.stamp ?? r.t0) !== null);
  const start = (r: RoundRecord) => (r.stamp !== null && r.stamp > 0 ? r.stamp : (r.t0 as number));
  const totals = ok.map((r) => Math.max(0, (r.t6 as number) - start(r))).sort((a, b) => a - b);
  const seg = (f: (r: RoundRecord) => number | null) =>
    mean(ok.map(f).filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0));
  const sortedGaps = [...frameGaps].sort((a, b) => a - b);
  const gapSum = frameGaps.reduce((a, b) => a + b, 0);
  return {
    samples: ok.length,
    timeouts: measured.filter((r) => r.timedOut).length,
    keystrokePaintP50Ms: pct(totals, 50),
    keystrokePaintP95Ms: pct(totals, 95),
    keystrokePaintP99Ms: pct(totals, 99),
    keystrokePaintMaxMs: totals.length > 0 ? totals[totals.length - 1] : 0,
    inputQueueMeanMs: seg((r) => (r.t0 !== null && r.stamp !== null ? r.t0 - r.stamp : null)),
    inputEncodeMeanMs: seg((r) => (r.t1 !== null && r.t0 !== null ? r.t1 - r.t0 : null)),
    ptyRoundTripMeanMs: seg((r) => (r.t4 !== null && r.t1 !== null ? r.t4 - r.t1 : null)),
    parseMeanMs: seg((r) => (r.t5 !== null && r.t4 !== null ? r.t5 - r.t4 : null)),
    paintMeanMs: seg((r) => (r.t6 !== null && r.t5 !== null ? Math.max(0, r.t6 - r.t5) : null)),
    repaintBytesPerKeystroke: mean(ok.map((r) => r.bytes)),
    frameGapP50Ms: pct(sortedGaps, 50),
    frameGapP95Ms: pct(sortedGaps, 95),
    frameGapP99Ms: pct(sortedGaps, 99),
    frameGapMaxMs: sortedGaps.length > 0 ? sortedGaps[sortedGaps.length - 1] : 0,
    fpsDuringMeasurement: gapSum > 0 ? (frameGaps.length / gapSum) * 1000 : 0,
    loafCount: loaf.count,
    loafTotalMs: loaf.totalMs,
  };
}

function fmtCell(r: CellResult): string {
  const m = r.metrics;
  return (
    `${r.cell.padEnd(15)} n=${String(m.samples).padStart(3)} to=${m.timeouts}` +
    ` paint p50=${m.keystrokePaintP50Ms.toFixed(1).padStart(7)} p95=${m.keystrokePaintP95Ms.toFixed(1).padStart(7)} p99=${m.keystrokePaintP99Ms.toFixed(1).padStart(7)}` +
    ` | q=${m.inputQueueMeanMs.toFixed(1)} enc=${m.inputEncodeMeanMs.toFixed(1)} rtt=${m.ptyRoundTripMeanMs.toFixed(1)} parse=${m.parseMeanMs.toFixed(1)} paint=${m.paintMeanMs.toFixed(1)}` +
    ` | gap p95=${m.frameGapP95Ms.toFixed(1)} fps=${m.fpsDuringMeasurement.toFixed(0)} loaf=${m.loafCount}` +
    ` | bytes/key=${m.repaintBytesPerKeystroke.toFixed(0)} [${r.rendererMode ?? "?"}]`
  );
}

// Exact-value gate: "0"/"false" must not enable a multi-minute benchmark.
const perfDescribe =
  process.env.RUN_PERF_INTERACTIVITY === "1" ? test.describe.serial : test.describe.skip;

perfDescribe("Perf: keystroke-to-paint interactivity (PERF-120..122)", () => {
  const results: CellResult[] = [];

  for (const cell of CELLS) {
    test(`interactivity: ${cell.key}`, async () => {
      test.slow();
      test.setTimeout(900_000);

      const fixture: FixtureRepo = createFixtureRepo({ name: `interactivity-${cell.key}` });
      const scriptsDir = path.join(fixture.dir, ".perf-scripts");
      mkdirSync(scriptsDir, { recursive: true });
      const composerSimPath = path.join(scriptsDir, "composer-sim.js");
      const replayPath = path.join(scriptsDir, "corpus-replay.js");
      writeFileSync(composerSimPath, composerSimSource());
      writeFileSync(replayPath, corpusReplaySource());

      let ctx: AppContext | undefined;
      try {
        // enableWebgl matches production rendering and keeps the GPU process
        // out-of-process — the local-macOS --in-process-gpu default makes a
        // compositor fault under sustained terminal streaming fatal to the app
        // (see store-fanout-perf.spec.ts).
        ctx = await launchApp({ enableWebgl: true });
        ctx.window = await openAndOnboardProject(
          ctx.app,
          ctx.window,
          fixture.dir,
          `Interactivity ${cell.key}`
        );
        const page = ctx.window;

        // Measured pane first so it keeps grid position 0.
        await openTerminal(page);
        const measuredPanel = page.locator('[data-panel-location="grid"]').first();
        await waitForTerminalReady(page, measuredPanel);
        const idsAfterFirst = await getGridPanelIds(page);
        expect(idsAfterFirst.length).toBe(1);
        const measuredPanelId = idsAfterFirst[0];

        const workloadCmd =
          cell.workload === "cat" ? "cat" : `node "${composerSimPath.replace(/"/g, '\\"')}"`;
        await runTerminalCommand(page, measuredPanel, workloadCmd);
        if (cell.workload === "composer-sim") {
          await expect
            .poll(
              () =>
                page.evaluate((id: string) => {
                  const read = (window as any).__daintreeReadTerminalBuffer;
                  return typeof read === "function" ? (read(id) as string) : "";
                }, measuredPanelId),
              { timeout: 30_000, intervals: [200, 500] }
            )
            .toContain("COMPOSER_SIM_READY");
        } else {
          await page.waitForTimeout(1_200);
        }

        // Background flood: real PTYs replaying the seeded corpus.
        if (cell.background > 0) {
          for (let i = 0; i < cell.background; i++) {
            const before = await getGridPanelIds(page);
            await openTerminal(page);
            await expect
              .poll(() => getGridPanelIds(page).then((ids) => ids.length), {
                timeout: 20_000,
                intervals: [100, 250, 500],
              })
              .toBe(before.length + 1);
            const after = await getGridPanelIds(page);
            const newId = after.find((id) => !before.includes(id));
            expect(newId, `background terminal ${i} panel id`).toBeTruthy();
            const bgPanel = page.locator(`[data-panel-id="${newId}"]`);
            await waitForTerminalReady(page, bgPanel);
            await runTerminalCommand(
              page,
              bgPanel,
              `node "${replayPath.replace(/"/g, '\\"')}" ${1000 + i * 97} ${cell.floodMode}`
            );
          }
          // Confirm at least one flood stream is flowing before measuring.
          const lastBgId = (await getGridPanelIds(page)).at(-1)!;
          const lenBefore = await page.evaluate((id: string) => {
            const fn = (window as any).__daintreeGetTerminalBufferLength;
            return typeof fn === "function" ? (fn(id) as number) : 0;
          }, lastBgId);
          await expect
            .poll(
              () =>
                page.evaluate((id: string) => {
                  const fn = (window as any).__daintreeGetTerminalBufferLength;
                  return typeof fn === "function" ? (fn(id) as number) : 0;
                }, lastBgId),
              { timeout: 20_000, intervals: [250, 500] }
            )
            .toBeGreaterThan(lenBefore);
          // Let the flood reach steady state (renderer tiers, backpressure).
          await page.waitForTimeout(3_000);
        }

        await focusMeasuredPane(page, measuredPanelId);
        await installProbe(page, measuredPanelId);

        // Anchor rounds prime the pipeline and give expected-text checks a
        // collision-proof prefix. Unmeasured; a timeout here means the echo
        // pipeline is broken, so fail loudly.
        for (const [i, ch] of [...ANCHOR].entries()) {
          const spec: RoundSpec = {
            idx: -2 + i,
            kind: "type",
            measured: false,
            expectKey: ch,
            expectData: ch,
            expectText: ANCHOR.slice(0, i + 1),
            forbidText: null,
          };
          await runRound(page, measuredPanelId, spec);
        }
        const anchorRounds = (await page.evaluate(
          () => (window as any).__DAINTREE_INTERACTIVITY_PROBE__.snapshot().rounds
        )) as RoundRecord[];
        const anchorTimeouts = anchorRounds.filter((r) => r.timedOut).length;
        expect(anchorTimeouts, "anchor keystrokes must echo and paint").toBe(0);

        // Pacing stats cover exactly the round window (warmups + measured).
        await page.evaluate(() => (window as any).__DAINTREE_INTERACTIVITY_PROBE__.resetPacing());

        const rounds = buildRounds(WARMUP + ROUNDS);
        for (const spec of rounds) {
          await runRound(page, measuredPanelId, spec);
        }

        const snapshot = (await page.evaluate(() => {
          const probe = (window as any).__DAINTREE_INTERACTIVITY_PROBE__;
          const snap = probe.snapshot();
          probe.dispose();
          return snap;
        })) as { rounds: RoundRecord[]; frameGaps: number[]; loaf: any };

        const rendererMode = (await page.evaluate((id: string) => {
          const fn = (window as any).__daintreeGetTerminalWebGLState;
          return typeof fn === "function" ? (fn(id)?.mode ?? null) : null;
        }, measuredPanelId)) as string | null;
        const dims = (await page.evaluate((id: string) => {
          const fn = (window as any).__daintreeGetTerminalDimensions;
          return typeof fn === "function" ? fn(id) : null;
        }, measuredPanelId)) as { cols: number; rows: number } | null;

        const roundRecords = snapshot.rounds.filter((r) => r.idx >= 0);
        const metrics = computeMetrics(roundRecords, snapshot.frameGaps, snapshot.loaf);
        const result: CellResult = {
          cell: cell.key,
          scenarioId: cell.scenarioId,
          workload: cell.workload,
          background: cell.background,
          floodMode: cell.floodMode,
          rendererMode,
          dims,
          metrics,
          rounds: roundRecords,
        };
        results.push(result);
        console.log(`──── ${cell.scenarioId} ${cell.key} ────`);
        console.log(fmtCell(result));

        // Reliability invariants only — latency is reported, never asserted.
        expect(metrics.samples + metrics.timeouts, "every measured round accounted for").toBe(
          ROUNDS
        );
        if (cell.background === 0) {
          expect(metrics.timeouts, "solo cells must not time out").toBe(0);
        } else {
          expect(metrics.samples, "flood cells must confirm at least one round").toBeGreaterThan(0);
        }
      } finally {
        if (ctx?.app) await closeApp(ctx.app);
        fixture.cleanup();
      }
    });
  }

  test.afterAll(() => {
    if (results.length === 0) return;
    const byCell = new Map(results.map((r) => [r.cell, r]));
    const solo = byCell.get("sim-solo");
    const fleet = byCell.get("sim-fleet");
    const saturation = byCell.get("sim-saturation");
    const ratio = (a?: CellResult, b?: CellResult) =>
      a && b && b.metrics.keystrokePaintP99Ms > 0
        ? a.metrics.keystrokePaintP99Ms / b.metrics.keystrokePaintP99Ms
        : null;
    const summary = {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      rounds: ROUNDS,
      warmup: WARMUP,
      settleMs: SETTLE_MS,
      roundTimeoutMs: ROUND_TIMEOUT_MS,
      echoDegradationFleetX: ratio(fleet, solo),
      echoDegradationSaturationX: ratio(saturation, solo),
      cells: results,
    };
    console.log("──── interactivity summary ────");
    for (const r of results) console.log(fmtCell(r));
    if (summary.echoDegradationFleetX !== null) {
      console.log(`echoDegradationX (fleet/solo p99): ${summary.echoDegradationFleetX.toFixed(2)}`);
    }
    if (summary.echoDegradationSaturationX !== null) {
      console.log(
        `echoDegradationX (saturation/solo p99): ${summary.echoDegradationSaturationX.toFixed(2)}`
      );
    }
    const outPath =
      OUT_PATH || path.join(tmpdir(), `daintree-interactivity-perf-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`interactivity results written to ${outPath}`);
  });
});
