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

// PERF-125..127 — TUI-scroll-under-load benchmark (the wheel analogue of the
// PERF-120..122 keystroke benchmark). Measures what a user feels scrolling a
// full-screen mouse-reporting TUI (grok CLI, opencode, lazygit): turn the
// wheel and count the milliseconds until the TUI's redraw is painted. Each
// wheel notch round-trips the full pipeline: wheel event → normalizer →
// paced synthetic reports → batched PTY write → TUI scrolls + repaints →
// pty-host → MessagePort → parse → paint.
//
// The fixture is a deterministic synthetic TUI: alt screen (?1049) + SGR
// mouse reporting (?1000/?1002/?1006), scrolls one line per wheel report and
// stamps every repaint with a sentinel `@@S F:<seq> T:<topline> @@` readable
// from the xterm buffer — so paint confirmation is a buffer read, not pixel
// diffing. LOAD-BEARING: the app's wheel takeover only engages when the
// terminal is in the alt buffer AND mouse tracking is active
// (TerminalListenerInstaller flushWheelLines gate); the probe asserts both
// before trusting any number.
//
// Two gesture shapes per cell (the wheel classifier treats them differently;
// historical stalls were flick-only):
//   paced  discrete notches (deltaY=120 @ 50ms) — classified physical wheel.
//          Headline: per-notch wheel→paint latency (expected position from
//          reports ACTUALLY written to the PTY, observed via onData — never
//          from raw deltas, which would penalize the pacing layer's
//          deliberate backlog clamp).
//   flick  momentum burst (fractional decaying deltas @ ~12ms) — classified
//          trackpad. Reported: settle time after the last physical event,
//          displayed-frame rate, dropped (clamped) lines. The backlog clamp
//          is a deliberate tradeoff: droppedLines is reported, never gated.
//
// Cells:
//   scroll-solo        PERF-125  1 standard TUI, full-size pane — the floor
//   scroll-heavy-solo  PERF-125  1 heavy TUI (~4x SGR-dense repaint bytes)
//   scroll-fleet       PERF-126  1 TUI + 12 bg terminals streaming ~32KB/s
//                                corpus replay (identical load to PERF-121)
//   scroll-concurrent  PERF-127  THE HEADLINE: 6 TUIs all scrolling at once
//                                (real CDP wheel on the measured one,
//                                synthetic WheelEvents on the other 5 — same
//                                full round-trip) + a bystander cat terminal
//                                with a keystroke-echo probe, so the
//                                "scrolling one TUI locks up everything"
//                                failure mode can never ship silently.
//
// Day-one gates are reliability invariants only (latency is reported, never
// asserted — absolute budgets come from a nightly calibration soak):
//   - solo cells: zero frame stalls > 250ms during measurement
//   - concurrent cell: zero bystander echo timeouts
//   - paced-phase settle < 500ms (flick settle is pacing-dominated by
//     design: reported, not gated)
//
// Opt-in only (multi-minute run, never a CI gate):
//   npm run build:e2e
//   RUN_PERF_SCROLL=1 npx playwright test --project=full-terminal \
//     e2e/full/terminal/scroll-perf.spec.ts

const CYCLES = Math.max(1, Math.floor(Number(process.env.PERF_SCROLL_CYCLES) || 3));
const NOTCHES = Math.max(5, Math.floor(Number(process.env.PERF_SCROLL_NOTCHES) || 30));
const NOTCH_GAP_MS = Math.max(20, Math.floor(Number(process.env.PERF_SCROLL_NOTCH_GAP_MS) || 50));
const FLICK_EVENTS = Math.max(10, Math.floor(Number(process.env.PERF_SCROLL_FLICK_EVENTS) || 30));
const QUIESCE_MS = 1_500;
const NOTCH_TIMEOUT_MS = 2_000;
const ECHO_TIMEOUT_MS = 2_000;
const OUT_PATH = process.env.PERF_SCROLL_OUT ?? "";
const CELL_FILTER = (process.env.PERF_SCROLL_CELLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface CellDef {
  key: string;
  scenarioId: string;
  variant: "standard" | "heavy";
  /** Corpus-replay background terminals (PERF-126 fleet load). */
  bgStream: number;
  /** Additional mouse-reporting TUIs scrolled concurrently via synthetic wheels. */
  bgTuis: number;
  /** Bystander `cat` terminal with a keystroke-echo probe. */
  echoProbe: boolean;
}

const ALL_CELLS: CellDef[] = [
  {
    key: "scroll-solo",
    scenarioId: "PERF-125",
    variant: "standard",
    bgStream: 0,
    bgTuis: 0,
    echoProbe: false,
  },
  {
    key: "scroll-heavy-solo",
    scenarioId: "PERF-125",
    variant: "heavy",
    bgStream: 0,
    bgTuis: 0,
    echoProbe: false,
  },
  {
    key: "scroll-fleet",
    scenarioId: "PERF-126",
    variant: "standard",
    bgStream: 12,
    bgTuis: 0,
    echoProbe: false,
  },
  {
    key: "scroll-concurrent",
    scenarioId: "PERF-127",
    variant: "standard",
    bgStream: 0,
    bgTuis: 5,
    echoProbe: true,
  },
];

const CELLS =
  CELL_FILTER.length > 0 ? ALL_CELLS.filter((c) => CELL_FILTER.includes(c.key)) : ALL_CELLS;

// Deterministic synthetic mouse-reporting TUI. One line of scroll per SGR
// wheel report, one repaint per stdin chunk (reports in a chunk coalesce into
// a single redraw — the same shape as a real TUI's read()-process-repaint
// loop). Every repaint rewrites the full screen and stamps row 0 with the
// frame/position sentinel. `heavy` pads each line with truecolor spans for an
// SGR-dense repaint (~4x the bytes) without changing the geometry.
function tuiSimSource(): string {
  return [
    "#!/usr/bin/env node",
    "const out = process.stdout;",
    "const ESC = '\\u001b';",
    "const heavy = process.argv[2] === 'heavy';",
    "const TOTAL = 50000;",
    "let top = 0, seq = 0;",
    "let rows = out.rows || 24;",
    "let cols = out.columns || 80;",
    "const WORDS = ['alpha','delta','gamma','sigma','omega','theta','kappa','lambda'];",
    "function lineText(n) {",
    "  let s = ESC + '[3' + (1 + (n % 6)) + 'm' + String(n).padStart(6, '0') + ESC + '[0m ';",
    "  let visible = 7;",
    "  let i = n;",
    "  while (visible < cols - 12) {",
    "    const w = WORDS[i % WORDS.length] + '-' + (i % 997) + ' ';",
    "    if (heavy) {",
    "      const r = (n * 37 + i) % 200 + 30, g = (n * 53 + i) % 200 + 30, b = (n * 71 + i) % 200 + 30;",
    "      s += ESC + '[38;2;' + r + ';' + g + ';' + b + 'm' + w + ESC + '[0m';",
    "    } else {",
    "      s += w;",
    "    }",
    "    visible += w.length;",
    "    i = (i * 31 + 7) % 100003;",
    "  }",
    "  return s;",
    "}",
    "function paint() {",
    "  seq++;",
    "  let s = ESC + '[H';",
    "  s += '@@S F:' + seq + ' T:' + top + ' @@' + ESC + '[K';",
    "  for (let r = 1; r < rows; r++) s += '\\r\\n' + lineText(top + r) + ESC + '[K';",
    "  out.write(s);",
    "}",
    "out.write(ESC + '[?1049h' + ESC + '[?1000h' + ESC + '[?1002h' + ESC + '[?1006h' + ESC + '[?25l');",
    "paint();",
    "process.stdin.setRawMode(true);",
    "process.stdin.resume();",
    "process.stdin.setEncoding('utf8');",
    "let tail = '';",
    "process.stdin.on('data', (chunk) => {",
    "  const data = tail + chunk;",
    "  if (data.includes('\\u0003')) {",
    "    out.write(ESC + '[?1006l' + ESC + '[?1002l' + ESC + '[?1000l' + ESC + '[?1049l' + ESC + '[?25h');",
    "    process.stdin.setRawMode(false);",
    "    process.exit(0);",
    "  }",
    "  let moved = 0, lastIndex = 0;",
    "  const re = /\\u001b\\[<(\\d+);(\\d+);(\\d+)([Mm])/g;",
    "  let m;",
    "  while ((m = re.exec(data))) {",
    "    if (m[4] === 'M') {",
    "      const btn = Number(m[1]);",
    "      if (btn === 64) moved -= 1;",
    "      else if (btn === 65) moved += 1;",
    "    }",
    "    lastIndex = re.lastIndex;",
    "  }",
    "  tail = data.slice(lastIndex);",
    "  if (!tail.includes(ESC) || tail.length > 128) tail = '';",
    "  if (moved !== 0) {",
    "    top = Math.max(0, Math.min(TOTAL - rows, top + moved));",
    "    paint();",
    "  }",
    "});",
    "out.on('resize', () => { rows = out.rows || rows; cols = out.columns || cols; paint(); });",
    "process.on('SIGTERM', () => process.exit(0));",
    "",
  ].join("\n");
}

// Background corpus replay — identical to the PERF-121 fleet load so the two
// benchmarks' fleet cells are directly comparable: seeded xorshift32 stream of
// pseudo agent-log lines, ~8KB burst every 250ms (~32KB/s) per terminal.
function corpusReplaySource(): string {
  return [
    "#!/usr/bin/env node",
    "const seed = Number(process.argv[2]) || 1;",
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
    "setInterval(() => { process.stdout.write(chunk(8192)); }, 250);",
    "",
  ].join("\n");
}

interface NotchRec {
  t: number;
  deltaY: number;
}
interface ReportRec {
  t: number;
  dir: number;
}
interface PaintRec {
  seq: number;
  top: number;
  tRender: number;
  tPaint: number | null;
}
interface PhaseRec {
  name: string;
  tStart: number;
  tEnd: number;
}

interface ProbeSnapshot {
  notches: NotchRec[];
  reports: ReportRec[];
  paints: PaintRec[];
  writes: { t: number; bytes: number }[];
  phases: PhaseRec[];
  frameGaps: number[];
  loaf: { count: number; totalMs: number; max: number };
  bytesWritten: number;
  mouseTrackingMode: string;
  bufferType: string;
}

interface EchoRound {
  ch: string;
  tPress: number;
  tInput: number | null;
  tPaint: number | null;
}

interface PhaseMetrics {
  phase: string;
  samples: number;
  unconfirmed: number;
  notchPaintP50Ms: number;
  notchPaintP95Ms: number;
  notchPaintP99Ms: number;
  notchPaintMaxMs: number;
  /** Physical wheel event → first NEW painted frame (any movement). */
  notchMoveP50Ms: number;
  notchMoveP95Ms: number;
  /** Distinct sentinel frames painted per second while the gesture ran. */
  displayedFps: number;
  /** Lines written to the PTY during the phase. */
  linesWritten: number;
  /** Lines the raw gesture requested minus lines written (backlog clamp). */
  droppedLines: number;
  /** Last physical event → final position painted. */
  settleMs: number;
  /** Mean notch → first repaint-chunk arrival at terminal.write (transport). */
  transportMeanMs: number;
  /** Mean repaint-chunk arrival → confirming paint (parse + render + present). */
  paintMeanMs: number;
}

interface CellMetrics {
  paced: PhaseMetrics;
  flick: PhaseMetrics;
  frameGapP50Ms: number;
  frameGapP95Ms: number;
  frameGapP99Ms: number;
  frameGapMaxMs: number;
  stallsOver100Ms: number;
  stallsOver250Ms: number;
  loafCount: number;
  loafTotalMs: number;
  repaintBytesPerFrame: number;
  echoSamples: number;
  echoTimeouts: number;
  /** Keystrokes CDP never delivered to xterm (harness artifact, not gated). */
  echoInputDrops: number;
  echoP50Ms: number;
  echoP95Ms: number;
  echoMaxMs: number;
}

interface CellResult {
  cell: string;
  scenarioId: string;
  variant: string;
  bgStream: number;
  bgTuis: number;
  rendererMode: string | null;
  dims: { cols: number; rows: number } | null;
  cellHeightPx: number;
  mouseTrackingMode: string;
  metrics: CellMetrics;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// Probe on the measured TUI terminal. Everything is stamped on the renderer's
// performance.now() clock (event.timeStamp shares it):
//   notches  physical wheel events (deltaMode 0) targeting the measured panel
//   reports  SGR wheel reports leaving via xterm onData — these ARE the lines
//            actually written to the PTY (the amplifier writes exactly what
//            onData emits, batched per frame)
//   paints   sentinel changes observed on onRender, presentation-stamped at
//            the next rAF (same approximation as the keystroke benchmark)
async function installScrollProbe(page: any, panelId: string): Promise<void> {
  await page.evaluate((id: string) => {
    const term = (window as any).__daintreeGetTerminalForE2E?.(id);
    if (!term) throw new Error(`scroll probe: no terminal for panel ${id}`);
    const probe: any = {
      notches: [],
      reports: [],
      paints: [],
      writes: [],
      phases: [],
      openPhase: null,
      frame: { gaps: [], last: 0, rafId: 0 },
      loaf: { count: 0, totalMs: 0, max: 0 },
      bytesWritten: 0,
      lastSeq: -1,
      disposed: false,
    };
    const onWheel = (ev: WheelEvent) => {
      if (ev.deltaMode !== 0) return;
      const el = ev.target as HTMLElement | null;
      if (!el?.closest?.(`[data-panel-id="${id}"]`)) return;
      probe.notches.push({ t: ev.timeStamp, deltaY: ev.deltaY });
    };
    window.addEventListener("wheel", onWheel, { capture: true });
    const d1 = term.onData((d: string) => {
      const re = /\[<(6[45]);\d+;\d+M/g;
      let m;
      while ((m = re.exec(d))) {
        probe.reports.push({ t: performance.now(), dir: m[1] === "65" ? 1 : -1 });
      }
    });
    const origWrite = term.write.bind(term);
    term.write = (data: any, cb?: () => void) => {
      const bytes = typeof data === "string" ? data.length : (data?.length ?? 0);
      probe.bytesWritten += bytes;
      probe.writes.push({ t: performance.now(), bytes });
      return origWrite(data, cb);
    };
    const readSentinel = () => {
      const buf = term.buffer.active;
      const line = buf.getLine(buf.baseY);
      const text = line ? line.translateToString(true) : "";
      const m = /@@S F:(\d+) T:(\d+) @@/.exec(text);
      return m ? { seq: Number(m[1]), top: Number(m[2]) } : null;
    };
    const d2 = term.onRender(() => {
      const s = readSentinel();
      if (!s || s.seq === probe.lastSeq) return;
      probe.lastSeq = s.seq;
      const rec: any = { seq: s.seq, top: s.top, tRender: performance.now(), tPaint: null };
      probe.paints.push(rec);
      requestAnimationFrame((ts) => {
        rec.tPaint = ts;
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
    probe.beginPhase = (name: string) => {
      probe.openPhase = { name, tStart: performance.now(), tEnd: 0 };
    };
    probe.endPhase = () => {
      if (!probe.openPhase) return;
      probe.openPhase.tEnd = performance.now();
      probe.phases.push(probe.openPhase);
      probe.openPhase = null;
    };
    probe.resetPacing = () => {
      probe.frame.gaps = [];
      probe.frame.last = 0;
      probe.loaf = { count: 0, totalMs: 0, max: 0 };
      probe.bytesWritten = 0;
    };
    probe.lastPaintedTop = () => {
      const last = probe.paints[probe.paints.length - 1];
      return last ? last.top : null;
    };
    probe.snapshot = () => ({
      notches: probe.notches,
      reports: probe.reports,
      paints: probe.paints,
      writes: probe.writes,
      phases: probe.phases,
      frameGaps: probe.frame.gaps,
      loaf: probe.loaf,
      bytesWritten: probe.bytesWritten,
      mouseTrackingMode: term.modes.mouseTrackingMode,
      bufferType: term.buffer.active.type,
    });
    probe.dispose = () => {
      probe.disposed = true;
      cancelAnimationFrame(probe.frame.rafId);
      window.removeEventListener("wheel", onWheel, { capture: true } as any);
      d1.dispose();
      d2.dispose();
      term.write = origWrite;
      po?.disconnect();
    };
    (window as any).__DAINTREE_SCROLL_PROBE__ = probe;
  }, panelId);
}

// Bystander keystroke-echo probe (concurrent cell): a `cat` terminal keeps
// keyboard focus while the wheel scrolls the measured TUI by cursor position.
// Each round presses one char; confirmation is the accumulated line appearing
// in a painted frame. A round's expected text is snapshotted when xterm's
// onData actually sees the char (input arrival), so a CDP-dropped keystroke
// is classified as an input drop (harness artifact, reported separately) and
// can never poison later rounds' expectations. A round with input arrival but
// no paint within the timeout is a REAL starved echo (echoTimeouts must be 0).
async function installEchoProbe(page: any, panelId: string): Promise<void> {
  await page.evaluate((id: string) => {
    const term = (window as any).__daintreeGetTerminalForE2E?.(id);
    if (!term) throw new Error(`echo probe: no terminal for panel ${id}`);
    const probe: any = { rounds: [], pending: [], sent: "", disposed: false };
    const regionText = () => {
      const buf = term.buffer.active;
      const cursorAbs = buf.baseY + buf.cursorY;
      const lo = Math.max(0, cursorAbs - 3);
      const rows: string[] = [];
      for (let i = lo; i <= cursorAbs; i++) {
        const line = buf.getLine(i);
        if (line) rows.push(line.translateToString(true));
      }
      return rows.join("\n");
    };
    const d1 = term.onData((data: string) => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          probe.sent = "";
          continue;
        }
        if (ch < " ") continue;
        probe.sent += ch;
        const rec = probe.pending.find((r: any) => r.ch === ch && r.tInput === null);
        if (rec) {
          rec.tInput = performance.now();
          rec.expect = probe.sent;
        }
      }
    });
    const d2 = term.onRender(() => {
      if (probe.pending.length === 0) return;
      const text = regionText();
      probe.pending = probe.pending.filter((r: any) => {
        if (r.tInput === null || !text.includes(r.expect)) return true;
        r.tPaint = performance.now();
        return false;
      });
    });
    probe.begin = (ch: string) => {
      const rec = { ch, tPress: performance.now(), tInput: null, expect: "", tPaint: null };
      probe.rounds.push(rec);
      probe.pending.push(rec);
      return probe.sent.length;
    };
    probe.resetLine = () => {
      // Driven via the terminal bridge (not a keyboard Enter): write "\r" to
      // the PTY and reset the accumulated-line state in the same task, so the
      // probe can never desynchronize from the cat line it validates against.
      (window as any).electron?.terminal?.write?.(id, "\r");
      probe.sent = "";
      probe.pending = probe.pending.filter((r: any) => r.tInput !== null);
    };
    probe.snapshot = () => probe.rounds;
    probe.dispose = () => {
      probe.disposed = true;
      d1.dispose();
      d2.dispose();
    };
    (window as any).__DAINTREE_ECHO_PROBE__ = probe;
  }, panelId);
}

// Synthetic wheel driver for the background TUIs in the concurrent cell: one
// deltaMode:0 WheelEvent per TUI per tick, dispatched at the terminal element
// — the exact entry point the amplifier listens on, so each background TUI
// still runs the full normalize→PTY→repaint→paint round trip. (Real CDP wheel
// can only aim at one cursor position; this is the documented-fidelity-gap
// path for the load TUIs.)
async function startBgTuiDriver(page: any, panelIds: string[], tickMs: number): Promise<void> {
  await page.evaluate(
    ({ ids, tick }: { ids: string[]; tick: number }) => {
      const timer = setInterval(() => {
        for (const id of ids) {
          const term = (window as any).__daintreeGetTerminalForE2E?.(id);
          const el = term?.element;
          if (!el) continue;
          const r = el.getBoundingClientRect();
          el.dispatchEvent(
            new WheelEvent("wheel", {
              deltaMode: 0,
              deltaY: 120,
              clientX: r.x + r.width / 2,
              clientY: r.y + r.height / 2,
              bubbles: true,
              cancelable: true,
            })
          );
        }
      }, tick);
      (window as any).__DAINTREE_BG_TUI_DRIVER__ = timer;
    },
    { ids: panelIds, tick: tickMs }
  );
}

async function stopBgTuiDriver(page: any): Promise<void> {
  await page.evaluate(() => {
    const t = (window as any).__DAINTREE_BG_TUI_DRIVER__;
    if (t) clearInterval(t);
    (window as any).__DAINTREE_BG_TUI_DRIVER__ = undefined;
  });
}

function phaseWindow(snapshot: ProbeSnapshot, name: string, cycle: number): PhaseRec | null {
  let seen = 0;
  for (const p of snapshot.phases) {
    if (p.name !== name) continue;
    if (seen === cycle) return p;
    seen++;
  }
  return null;
}

function inWindow<T extends { t: number }>(arr: T[], w: PhaseRec): T[] {
  return arr.filter((x) => x.t >= w.tStart && x.t < w.tEnd);
}

// Per-phase analysis. The measurement unit is the report actually written:
// expected position after notch k = painted top at phase start + cumulative
// reports written up to the next notch (attribution by time window — with the
// synchronous flush a paced notch's reports land within the same event turn).
function analyzePhase(
  snapshot: ProbeSnapshot,
  name: string,
  cellHeightPx: number,
  settleCapMs: number
): PhaseMetrics {
  const notchPaint: number[] = [];
  const notchMove: number[] = [];
  const transports: number[] = [];
  const paintSlices: number[] = [];
  let unconfirmed = 0;
  let linesWritten = 0;
  let requestedLines = 0;
  let displayedFrames = 0;
  let gestureMs = 0;
  const settles: number[] = [];

  for (let cycle = 0; ; cycle++) {
    const w = phaseWindow(snapshot, name, cycle);
    if (!w) break;
    // Extend the window by the settle allowance so tail paints/reports land in
    // the analysis, but never past the start of the NEXT phase — otherwise a
    // quiesce gap shorter than the allowance bleeds the next gesture's samples
    // into this phase's settle and last-notch attribution.
    const nextPhaseStart = snapshot.phases
      .map((p) => p.tStart)
      .filter((t) => t > w.tEnd)
      .sort((a, b) => a - b)[0];
    const extEnd =
      nextPhaseStart !== undefined
        ? Math.min(w.tEnd + settleCapMs, nextPhaseStart - 1)
        : w.tEnd + settleCapMs;
    const wExt: PhaseRec = { ...w, tEnd: extEnd };
    const notches = inWindow(snapshot.notches, w);
    const reports = inWindow(snapshot.reports, wExt);
    const paints = snapshot.paints.filter(
      (p) => p.tRender >= w.tStart && p.tRender < wExt.tEnd && p.tPaint !== null
    );
    if (notches.length === 0) continue;

    linesWritten += reports.length;
    requestedLines += Math.round(
      notches.reduce((a, n) => a + Math.abs(n.deltaY), 0) / Math.max(1, cellHeightPx)
    );
    displayedFrames += new Set(paints.map((p) => p.seq)).size;
    gestureMs += w.tEnd - w.tStart;

    // Painted top at phase start: last paint before the window, else first in.
    const before = snapshot.paints.filter((p) => p.tRender < w.tStart && p.tPaint !== null);
    const t0Top =
      before.length > 0 ? before[before.length - 1].top : paints.length > 0 ? paints[0].top : 0;

    for (let k = 0; k < notches.length; k++) {
      const tN = notches[k].t;
      const tNext = k + 1 < notches.length ? notches[k + 1].t : wExt.tEnd;
      const cumReports = reports.filter((r) => r.t < tNext).length;
      if (cumReports === 0) continue;
      const expectedTop = t0Top + cumReports;
      const hit = paints.find((p) => (p.tPaint as number) >= tN && p.top >= expectedTop);
      if (hit) {
        notchPaint.push((hit.tPaint as number) - tN);
        const arrival = snapshot.writes.find((x) => x.t >= tN && x.t <= (hit.tPaint as number));
        if (arrival) {
          transports.push(arrival.t - tN);
          paintSlices.push((hit.tPaint as number) - arrival.t);
        }
      } else {
        unconfirmed++;
      }
      const moved = paints.find((p) => (p.tPaint as number) > tN);
      if (moved) notchMove.push((moved.tPaint as number) - tN);
    }

    // Settle: last physical event → the final position of this cycle painted.
    const lastNotchT = notches[notches.length - 1].t;
    const finalTop = paints.length > 0 ? Math.max(...paints.map((p) => p.top)) : t0Top;
    const finalPaint = paints.find((p) => p.top >= finalTop);
    if (finalPaint) settles.push(Math.max(0, (finalPaint.tPaint as number) - lastNotchT));
  }

  const sortedPaint = [...notchPaint].sort((a, b) => a - b);
  const sortedMove = [...notchMove].sort((a, b) => a - b);
  return {
    phase: name,
    samples: sortedPaint.length,
    unconfirmed,
    notchPaintP50Ms: pct(sortedPaint, 50),
    notchPaintP95Ms: pct(sortedPaint, 95),
    notchPaintP99Ms: pct(sortedPaint, 99),
    notchPaintMaxMs: sortedPaint.length > 0 ? sortedPaint[sortedPaint.length - 1] : 0,
    notchMoveP50Ms: pct(sortedMove, 50),
    notchMoveP95Ms: pct(sortedMove, 95),
    displayedFps: gestureMs > 0 ? (displayedFrames / gestureMs) * 1000 : 0,
    linesWritten,
    droppedLines: Math.max(0, requestedLines - linesWritten),
    settleMs: settles.length > 0 ? Math.max(...settles) : 0,
    transportMeanMs:
      transports.length > 0 ? transports.reduce((a, b) => a + b, 0) / transports.length : 0,
    paintMeanMs:
      paintSlices.length > 0 ? paintSlices.reduce((a, b) => a + b, 0) / paintSlices.length : 0,
  };
}

function fmtPhase(m: PhaseMetrics): string {
  return (
    `${m.phase.padEnd(6)} n=${String(m.samples).padStart(3)}/${m.unconfirmed} ` +
    `paint p50=${m.notchPaintP50Ms.toFixed(1).padStart(7)} p95=${m.notchPaintP95Ms.toFixed(1).padStart(7)} p99=${m.notchPaintP99Ms.toFixed(1).padStart(7)} ` +
    `move p50=${m.notchMoveP50Ms.toFixed(1)} fps=${m.displayedFps.toFixed(1)} ` +
    `lines=${m.linesWritten} dropped=${m.droppedLines} settle=${m.settleMs.toFixed(0)} ` +
    `(rt=${m.transportMeanMs.toFixed(1)}+paint=${m.paintMeanMs.toFixed(1)})`
  );
}

function fmtCell(r: CellResult): string {
  const m = r.metrics;
  return (
    `──── ${r.scenarioId} ${r.cell} [${r.rendererMode ?? "?"} ${r.dims?.cols}x${r.dims?.rows}] ────\n` +
    `  ${fmtPhase(m.paced)}\n` +
    `  ${fmtPhase(m.flick)}\n` +
    `  gap p95=${m.frameGapP95Ms.toFixed(1)} p99=${m.frameGapP99Ms.toFixed(1)} max=${m.frameGapMaxMs.toFixed(0)} ` +
    `stalls>100=${m.stallsOver100Ms} >250=${m.stallsOver250Ms} loaf=${m.loafCount} ` +
    `bytes/frame=${m.repaintBytesPerFrame.toFixed(0)}` +
    (m.echoSamples > 0
      ? ` | echo n=${m.echoSamples} to=${m.echoTimeouts} drop=${m.echoInputDrops} p50=${m.echoP50Ms.toFixed(1)} p95=${m.echoP95Ms.toFixed(1)}`
      : "")
  );
}

const perfDescribe =
  process.env.RUN_PERF_SCROLL === "1" ? test.describe.serial : test.describe.skip;

perfDescribe("Perf: TUI scroll under load (PERF-125..127)", () => {
  const results: CellResult[] = [];

  for (const cell of CELLS) {
    test(`scroll: ${cell.key}`, async () => {
      test.slow();
      test.setTimeout(900_000);

      const fixture: FixtureRepo = createFixtureRepo({ name: `scroll-${cell.key}` });
      const scriptsDir = path.join(fixture.dir, ".perf-scripts");
      mkdirSync(scriptsDir, { recursive: true });
      const tuiPath = path.join(scriptsDir, "tui-sim.js");
      const replayPath = path.join(scriptsDir, "corpus-replay.js");
      writeFileSync(tuiPath, tuiSimSource());
      writeFileSync(replayPath, corpusReplaySource());

      let ctx: AppContext | undefined;
      try {
        // enableWebgl matches production rendering (see interactivity-perf).
        ctx = await launchApp({ enableWebgl: true });
        ctx.window = await openAndOnboardProject(
          ctx.app,
          ctx.window,
          fixture.dir,
          `Scroll ${cell.key}`
        );
        const page = ctx.window;

        const openPanel = async (): Promise<string> => {
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
          expect(newId, "new panel id").toBeTruthy();
          const panel = page.locator(`[data-panel-id="${newId}"]`);
          await waitForTerminalReady(page, panel);
          return newId!;
        };

        const startTui = async (panelId: string, variant: string) => {
          const panel = page.locator(`[data-panel-id="${panelId}"]`);
          await runTerminalCommand(
            page,
            panel,
            `node "${tuiPath.replace(/"/g, '\\"')}" ${variant}`
          );
          await expect
            .poll(
              () =>
                page.evaluate((id: string) => {
                  const read = (window as any).__daintreeReadTerminalBuffer;
                  return typeof read === "function" ? (read(id) as string) : "";
                }, panelId),
              { timeout: 30_000, intervals: [200, 500] }
            )
            .toContain("@@S F:");
        };

        // Measured TUI first so it keeps grid position 0. The bystander opens
        // second so it shares the visible top of an overflowing grid with the
        // measured pane — an offscreen bystander's renders are throttled and
        // its echo confirmations would (falsely) never paint.
        const measuredId = await openPanel();
        await startTui(measuredId, cell.variant);

        let echoId: string | null = null;
        if (cell.echoProbe) {
          echoId = await openPanel();
          const echoPanel = page.locator(`[data-panel-id="${echoId}"]`);
          await runTerminalCommand(page, echoPanel, "cat");
          await page.waitForTimeout(800);
        }

        // Fleet load: corpus-replay streams.
        for (let i = 0; i < cell.bgStream; i++) {
          const id = await openPanel();
          const panel = page.locator(`[data-panel-id="${id}"]`);
          await runTerminalCommand(
            page,
            panel,
            `node "${replayPath.replace(/"/g, '\\"')}" ${1000 + i * 97}`
          );
        }

        // Concurrent load: more mouse-reporting TUIs. These may land below the
        // fold in an overflowing grid — their wheel round-trips (normalize →
        // PTY → repaint → parse) are unaffected; only their painting cadence
        // is throttled offscreen.
        const bgTuiIds: string[] = [];
        for (let i = 0; i < cell.bgTuis; i++) {
          const id = await openPanel();
          await startTui(id, "standard");
          bgTuiIds.push(id);
        }

        if (cell.bgStream > 0) {
          // Let the flood reach steady state (renderer tiers, backpressure).
          await page.waitForTimeout(3_000);
        }

        // The wheel targets the measured TUI by cursor position; keyboard
        // focus goes to the bystander when present, else the measured pane.
        const measuredPanel = page.locator(`[data-panel-id="${measuredId}"]`);
        const focusTarget = echoId ? page.locator(`[data-panel-id="${echoId}"]`) : measuredPanel;
        await focusTarget
          .locator(".xterm")
          .first()
          .click({ position: { x: 30, y: 10 } });
        // Clicking the focus target may have auto-scrolled an overflowing grid
        // and pushed the measured pane out of the viewport; bring it back.
        // Layout diagnostics catch the case where both can't fit at once.
        await measuredPanel.scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
        {
          const layout = await page.evaluate(
            (ids: (string | null)[]) => {
              return {
                viewport: { w: window.innerWidth, h: window.innerHeight },
                panels: ids.filter(Boolean).map((id) => {
                  const el = document.querySelector(`[data-panel-id="${id}"]`);
                  const r = el?.getBoundingClientRect();
                  return r
                    ? {
                        id,
                        x: Math.round(r.x),
                        y: Math.round(r.y),
                        w: Math.round(r.width),
                        h: Math.round(r.height),
                      }
                    : { id, missing: true };
                }),
              };
            },
            [measuredId, echoId]
          );
          console.log(`[scroll-perf] ${cell.key} layout:`, JSON.stringify(layout));
        }

        await installScrollProbe(page, measuredId);
        if (echoId) await installEchoProbe(page, echoId);

        // LOAD-BEARING precondition: the wheel takeover only engages on the
        // alt buffer with mouse tracking active — verify before measuring.
        const modes = await page.evaluate(() => {
          const p = (window as any).__DAINTREE_SCROLL_PROBE__;
          return p.snapshot();
        });
        expect(modes.bufferType, "fixture must hold the alt buffer").toBe("alternate");
        expect(["vt200", "drag", "any"], "fixture must keep mouse tracking active").toContain(
          modes.mouseTrackingMode
        );

        const box = await measuredPanel.locator(".xterm").first().boundingBox();
        expect(box).toBeTruthy();
        const cx = box!.x + box!.width / 2;
        const cy = box!.y + box!.height / 2;
        const dims = (await page.evaluate((id: string) => {
          const fn = (window as any).__daintreeGetTerminalDimensions;
          return typeof fn === "function" ? fn(id) : null;
        }, measuredId)) as { cols: number; rows: number } | null;
        const cellHeightPx = dims && dims.rows > 0 ? box!.height / dims.rows : 17;

        // Warm-up: prove the wheel pipeline is alive before measuring, same
        // spirit as the interactivity anchor rounds. A dead pipeline fails
        // loudly here rather than producing an all-unconfirmed cell.
        await page.mouse.move(cx, cy);
        await page.mouse.wheel(0, 120);
        try {
          await expect
            .poll(
              () =>
                page.evaluate(
                  () => (window as any).__DAINTREE_SCROLL_PROBE__.snapshot().reports.length
                ),
              { timeout: 10_000, intervals: [100, 250] }
            )
            .toBeGreaterThan(0);
        } catch (err) {
          const diag = await page.evaluate(
            ({ id, x, y }: { id: string; x: number; y: number }) => {
              const p = (window as any).__DAINTREE_SCROLL_PROBE__;
              const snap = p.snapshot();
              const el = document.elementFromPoint(x, y) as HTMLElement | null;
              const term = (window as any).__daintreeGetTerminalForE2E?.(id);
              return {
                notches: snap.notches.length,
                reports: snap.reports.length,
                paints: snap.paints.length,
                mouseTrackingMode: term?.modes?.mouseTrackingMode,
                bufferType: term?.buffer?.active?.type,
                hitElement: el ? `${el.tagName}.${el.className}` : null,
                hitPanel: el?.closest?.("[data-panel-id]")?.getAttribute("data-panel-id") ?? null,
              };
            },
            { id: measuredId, x: cx, y: cy }
          );
          console.log(
            `[scroll-perf] warm-up wheel diagnostics for ${cell.key} (measured=${measuredId}):`,
            JSON.stringify(diag)
          );
          throw err;
        }
        await page.waitForTimeout(QUIESCE_MS);

        if (bgTuiIds.length > 0) {
          await startBgTuiDriver(page, bgTuiIds, 100);
          await page.waitForTimeout(500);
        }

        await page.evaluate(() => (window as any).__DAINTREE_SCROLL_PROBE__.resetPacing());

        // Echo cadence: one bystander keystroke every 4th paced notch and a
        // couple during each flick settle. Line-resets (Enter) are unmeasured.
        let echoCount = 0;
        const echoChar = () => String.fromCharCode(97 + (echoCount++ % 26));
        const pressEcho = async () => {
          if (!echoId) return;
          const ch = echoChar();
          const len = (await page.evaluate(
            (c: string) => (window as any).__DAINTREE_ECHO_PROBE__.begin(c),
            ch
          )) as number;
          await page.keyboard.press(ch);
          if (len >= 20) {
            await page.evaluate(() => (window as any).__DAINTREE_ECHO_PROBE__.resetLine());
          }
        };

        for (let cycle = 0; cycle < CYCLES; cycle++) {
          // Paced-notch phase: discrete detents, physical-wheel classified.
          await page.mouse.move(cx, cy);
          await page.evaluate(() => (window as any).__DAINTREE_SCROLL_PROBE__.beginPhase("paced"));
          for (let i = 0; i < NOTCHES; i++) {
            await page.mouse.wheel(0, 120);
            if (i % 4 === 3) await pressEcho();
            await page.waitForTimeout(NOTCH_GAP_MS);
          }
          await page.evaluate(() => (window as any).__DAINTREE_SCROLL_PROBE__.endPhase());
          await page.waitForTimeout(QUIESCE_MS);

          // Momentum flick: fractional decaying deltas, trackpad classified.
          await page.mouse.move(cx, cy);
          await page.evaluate(() => (window as any).__DAINTREE_SCROLL_PROBE__.beginPhase("flick"));
          let delta = 360.5;
          for (let i = 0; i < FLICK_EVENTS; i++) {
            await page.mouse.wheel(0, delta);
            delta = Math.max(8.3, delta * 0.93);
            await page.waitForTimeout(12);
          }
          await page.evaluate(() => (window as any).__DAINTREE_SCROLL_PROBE__.endPhase());
          await pressEcho();
          await page.waitForTimeout(600);
          await pressEcho();
          await page.waitForTimeout(QUIESCE_MS);
        }

        if (bgTuiIds.length > 0) await stopBgTuiDriver(page);

        // Bystander echo drain + timeout sweep.
        let echoRounds: EchoRound[] = [];
        if (echoId) {
          await page.waitForTimeout(ECHO_TIMEOUT_MS);
          echoRounds = (await page.evaluate(() => {
            const p = (window as any).__DAINTREE_ECHO_PROBE__;
            const rounds = p.snapshot();
            p.dispose();
            return rounds;
          })) as EchoRound[];
          const unconfirmed = echoRounds.filter((r) => r.tPaint === null);
          if (unconfirmed.length > 0) {
            const bufferTail = (await page.evaluate((id: string) => {
              const read = (window as any).__daintreeReadTerminalBuffer;
              const text = typeof read === "function" ? (read(id) as string) : "";
              return text
                .split("\n")
                .filter((l: string) => l.trim().length > 0)
                .slice(-6);
            }, echoId)) as string[];
            console.log(
              `[scroll-perf] unconfirmed echo rounds:`,
              JSON.stringify(unconfirmed),
              `bystander tail:`,
              JSON.stringify(bufferTail)
            );
          }
        }

        const snapshot = (await page.evaluate(() => {
          const p = (window as any).__DAINTREE_SCROLL_PROBE__;
          const snap = p.snapshot();
          p.dispose();
          return snap;
        })) as ProbeSnapshot;

        // Background TUIs must have actually scrolled (the load must be real).
        for (const id of bgTuiIds) {
          const text = (await page.evaluate((pid: string) => {
            const read = (window as any).__daintreeReadTerminalBuffer;
            return typeof read === "function" ? (read(pid) as string) : "";
          }, id)) as string;
          const m = /@@S F:(\d+) T:(\d+) @@/.exec(text);
          expect(m, `bg TUI ${id} sentinel`).toBeTruthy();
          expect(Number(m![2]), `bg TUI ${id} must have scrolled`).toBeGreaterThan(0);
        }

        const rendererMode = (await page.evaluate((id: string) => {
          const fn = (window as any).__daintreeGetTerminalWebGLState;
          return typeof fn === "function" ? (fn(id)?.mode ?? null) : null;
        }, measuredId)) as string | null;

        const paced = analyzePhase(snapshot, "paced", cellHeightPx, NOTCH_TIMEOUT_MS);
        const flick = analyzePhase(snapshot, "flick", cellHeightPx, NOTCH_TIMEOUT_MS);
        const sortedGaps = [...snapshot.frameGaps].sort((a, b) => a - b);
        const echoLat = echoRounds
          .filter((r) => r.tPaint !== null)
          .map((r) => (r.tPaint as number) - r.tPress)
          .sort((a, b) => a - b);
        const paintedFrames = snapshot.paints.filter((p) => p.tPaint !== null).length;
        const metrics: CellMetrics = {
          paced,
          flick,
          frameGapP50Ms: pct(sortedGaps, 50),
          frameGapP95Ms: pct(sortedGaps, 95),
          frameGapP99Ms: pct(sortedGaps, 99),
          frameGapMaxMs: sortedGaps.length > 0 ? sortedGaps[sortedGaps.length - 1] : 0,
          stallsOver100Ms: snapshot.frameGaps.filter((g) => g > 100).length,
          stallsOver250Ms: snapshot.frameGaps.filter((g) => g > 250).length,
          loafCount: snapshot.loaf.count,
          loafTotalMs: snapshot.loaf.totalMs,
          repaintBytesPerFrame: paintedFrames > 0 ? snapshot.bytesWritten / paintedFrames : 0,
          echoSamples: echoLat.length,
          echoTimeouts: echoRounds.filter((r) => r.tInput !== null && r.tPaint === null).length,
          echoInputDrops: echoRounds.filter((r) => r.tInput === null).length,
          echoP50Ms: pct(echoLat, 50),
          echoP95Ms: pct(echoLat, 95),
          echoMaxMs: echoLat.length > 0 ? echoLat[echoLat.length - 1] : 0,
        };
        const result: CellResult = {
          cell: cell.key,
          scenarioId: cell.scenarioId,
          variant: cell.variant,
          bgStream: cell.bgStream,
          bgTuis: cell.bgTuis,
          rendererMode,
          dims,
          cellHeightPx,
          mouseTrackingMode: snapshot.mouseTrackingMode,
          metrics,
        };
        results.push(result);
        console.log(fmtCell(result));

        // Day-one reliability invariants (latency is reported, never gated).
        expect(paced.samples, "paced phase must confirm rounds").toBeGreaterThan(0);
        expect(flick.linesWritten, "flick phase must write reports").toBeGreaterThan(0);
        expect(paced.settleMs, "paced settle").toBeLessThan(500);
        if (cell.bgStream === 0 && cell.bgTuis === 0) {
          expect(metrics.stallsOver250Ms, "solo cells must not stall > 250ms").toBe(0);
        }
        if (cell.echoProbe) {
          expect(metrics.echoSamples, "echo probe must produce samples").toBeGreaterThan(0);
          expect(metrics.echoTimeouts, "bystander echo must never time out").toBe(0);
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
    const solo = byCell.get("scroll-solo");
    const concurrent = byCell.get("scroll-concurrent");
    const fleet = byCell.get("scroll-fleet");
    const ratio = (a?: CellResult, b?: CellResult) =>
      a && b && b.metrics.paced.notchPaintP99Ms > 0
        ? a.metrics.paced.notchPaintP99Ms / b.metrics.paced.notchPaintP99Ms
        : null;
    const summary = {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      cycles: CYCLES,
      notches: NOTCHES,
      notchGapMs: NOTCH_GAP_MS,
      flickEvents: FLICK_EVENTS,
      scrollDegradationFleetX: ratio(fleet, solo),
      scrollDegradationConcurrentX: ratio(concurrent, solo),
      cells: results,
    };
    console.log("──── scroll summary ────");
    for (const r of results) console.log(fmtCell(r));
    if (summary.scrollDegradationFleetX !== null) {
      console.log(
        `scrollDegradationX (fleet/solo p99): ${summary.scrollDegradationFleetX.toFixed(2)}`
      );
    }
    if (summary.scrollDegradationConcurrentX !== null) {
      console.log(
        `scrollDegradationX (concurrent/solo p99): ${summary.scrollDegradationConcurrentX.toFixed(2)}`
      );
    }
    const outPath = OUT_PATH || path.join(tmpdir(), `daintree-scroll-perf-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`scroll results written to ${outPath}`);
  });
});
