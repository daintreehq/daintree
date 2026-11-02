/**
 * README showcase capture.
 *
 * Boots the real app on a believable project ("Atlas Ledger", a TypeScript
 * payments ledger with five feature worktrees), runs four agent CLIs side by
 * side across those worktrees as one fleet, and writes the hero screenshot for
 * every built-in theme plus three feature stills, each in its own theme. The
 * agents are small fake CLIs that draw a pre-authored session in each real
 * CLI's style and drive Daintree's own agent-state detection (OSC 9;4
 * heartbeat and the registry's patterns), so the states on screen are the ones
 * the app observed, not painted on.
 *
 * Opt-in only, like its siblings:
 *
 *   DAINTREE_README_SHOTS=1 DAINTREE_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots readme-showcase --workers=1
 *
 * Iteration knobs: DAINTREE_README_THEMES (comma list of hero themes) and
 * DAINTREE_README_FEATURES (comma list of feature slugs, or "none").
 *
 * Output: hero-<themeId>.png for every built-in theme, pilot-fiordland.png,
 * worktree-overview-arashiyama.png, review-hub-hokkaido.png and manifest.json.
 * The run fails if any expected PNG is missing or the wrong size, if a hero was
 * captured with an agent in a state other than the one it was staged for, or
 * if a feature still never reached its surface.
 */

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { BUILT_IN_APP_SCHEMES } from "../../shared/theme/index.js";
import { launchApp, closeApp, pathRestoreProfile, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { dispatchAction } from "../helpers/actions";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = process.env.DAINTREE_README_SHOTS === "1";
const OUT = process.env.DAINTREE_CAPTURE_DIR ?? "";
const SCALE = "2";
const WINDOW = { width: 1600, height: 1000 };
const ONLY_THEMES = (process.env.DAINTREE_README_THEMES ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
// DAINTREE_README_THEMES narrows an iteration run; a full run covers every built-in theme.
const THEME_IDS = BUILT_IN_APP_SCHEMES.map((scheme) => scheme.id).filter(
  (id) => ONLY_THEMES.length === 0 || ONLY_THEMES.includes(id)
);
/** Feature stills, each in its own theme so the README tours both. Capture order. */
const FEATURE_SHOTS = [
  "pilot-fiordland",
  "worktree-overview-arashiyama",
  // Last: it docks the Claude pane to give the hub and its diff the grid.
  "review-hub-hokkaido",
] as const;
type FeatureShot = (typeof FEATURE_SHOTS)[number];
const ONLY_FEATURES = (process.env.DAINTREE_README_FEATURES ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
// DAINTREE_README_FEATURES narrows an iteration run ("none" skips them all).
const FEATURES: FeatureShot[] = FEATURE_SHOTS.filter(
  (slug) => ONLY_FEATURES.length === 0 || ONLY_FEATURES.includes(slug)
);
const themeOf = (slug: FeatureShot): string => slug.slice(slug.lastIndexOf("-") + 1);

const POLISH_ID = "readme-showcase-polish";
const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  div.fixed[role="region"][aria-label="Notifications"] { display: none !important; }
  [role="tooltip"], [data-radix-popper-content-wrapper]:has([role="tooltip"]) { display: none !important; }
  .xterm-cursor-layer { display: none !important; }
`;

// ---------------------------------------------------------------------------
// The fake CLIs
// ---------------------------------------------------------------------------

interface FakeCliScript {
  /** `--version` output. */
  versionText: string;
  /** OSC 0 title, which Daintree composes into the pane header. */
  title: string;
  /** Screen before the session starts, briefly. */
  boot: string[];
  /** Screen while working; `@spin` marks the live status row. */
  work: string[];
  /** Screen after the work phase; omit to work for as long as the pane lives. */
  settled?: string[];
  workMs?: number;
  /** `{g}` spinner glyph, `{t}` elapsed. */
  spin: string;
  glyphs: string;
  /** Seconds already "spent" when the pane opens, so timers read mid-session. */
  elapsedBase: number;
}

interface FakeCliConfig {
  /** Keyed by the launch directory's basename; `*` is the fallback. */
  scripts: Record<string, { key: string; script: FakeCliScript }>;
  stateDir: string;
}

/**
 * The CLI itself, serialized into the installed binary with toString(), so it
 * must stay self-contained.
 *
 * Screen DSL, one entry per row: `@rule:<sgr>` a full-width rule; `@box:<sgr>`
 * … `@endbox` rows framed in a rounded box as wide as its widest row;
 * `@boxfull:<sgr>` the same at full width; `@lr:<left>\t<right>` right-aligned
 * tail; `@spin` the live status row. Rows are cut to the pane's width, and only
 * the bottom `rows` rows are drawn, the way a real session scrolls.
 */
function fakeCliProgram(
  config: FakeCliConfig,
  fs: typeof import("fs"),
  nodePath: typeof import("path")
): void {
  const entry =
    config.scripts[nodePath.basename(process.cwd())] ??
    config.scripts["*"] ??
    (Object.values(config.scripts)[0] as { key: string; script: FakeCliScript });
  const s = entry.script;
  const argv = process.argv.slice(2);
  const done = (text: string): void => {
    process.stdout.write(text, () => process.exit(0));
  };
  if (argv.includes("--version") || argv.includes("-v")) return done(s.versionText + "\n");
  if (argv[0] === "app-server" || argv[0] === "mcp") return done("");
  if (argv[0] === "debug") return done('{"models":[]}\n');
  if (!process.stdin.isTTY) return done("");

  const ESC = "\u001b";
  const OSC_WORKING = ESC + "]9;4;1;0\u0007";
  const OSC_IDLE = ESC + "]9;4;0;0\u0007";
  const SGR_RESET = ESC + "[0m";
  const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
  const write = (text: string) => process.stdout.write(text);
  const visible = (text: string) => Array.from(text.replace(ANSI, "")).length;

  const fit = (line: string, width: number): string => {
    if (visible(line) <= width) return line;
    let outText = "";
    let count = 0;
    let i = 0;
    while (i < line.length && count < width - 1) {
      if (line[i] === ESC) {
        const m = /^\u001b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
        if (m) {
          outText += m[0];
          i += m[0].length;
          continue;
        }
      }
      const cp = line.codePointAt(i) as number;
      const ch = String.fromCodePoint(cp);
      outText += ch;
      i += ch.length;
      count += 1;
    }
    return outText + "…" + SGR_RESET;
  };

  const pad = (line: string, width: number) =>
    line + " ".repeat(Math.max(0, width - visible(line)));

  let phase: "boot" | "work" | "settled" = "boot";
  let workStarted = 0;
  let tick = 0;

  const fmtElapsed = () => {
    const secs = s.elapsedBase + Math.max(0, Math.floor((Date.now() - workStarted) / 1000));
    if (secs < 60) return secs + "s";
    const m = Math.floor(secs / 60);
    const r = secs % 60;
    return m + "m " + String(r).padStart(2, "0") + "s";
  };

  let lastSpinIndex = -1;
  const expand = (rows: string[], width: number): string[] => {
    lastSpinIndex = -1;
    const outRows: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as string;
      if (row.startsWith("@rule:")) {
        outRows.push(ESC + "[" + row.slice(6) + "m" + "─".repeat(width) + SGR_RESET);
      } else if (row.startsWith("@box:") || row.startsWith("@boxfull:")) {
        const full = row.startsWith("@boxfull:");
        const sgr = ESC + "[" + row.slice(full ? 9 : 5) + "m";
        const inner: string[] = [];
        while (i + 1 < rows.length && rows[i + 1] !== "@endbox") inner.push(rows[++i] as string);
        i++;
        const widest = Math.max(...inner.map(visible));
        const innerWidth = full ? width - 4 : Math.min(width - 4, widest);
        outRows.push(sgr + "╭" + "─".repeat(innerWidth + 2) + "╮" + SGR_RESET);
        for (const content of inner) {
          outRows.push(
            sgr +
              "│" +
              SGR_RESET +
              " " +
              pad(fit(content, innerWidth), innerWidth) +
              " " +
              sgr +
              "│" +
              SGR_RESET
          );
        }
        outRows.push(sgr + "╰" + "─".repeat(innerWidth + 2) + "╯" + SGR_RESET);
      } else if (row.startsWith("@lr:")) {
        const [left = "", right = ""] = row.slice(4).split("\t");
        const gap = width - visible(left) - visible(right) - 1;
        outRows.push(gap >= 1 ? left + " ".repeat(gap) + right : fit(left, width));
      } else if (row === "@spin") {
        lastSpinIndex = outRows.length;
        const glyph = Array.from(s.glyphs)[tick % Array.from(s.glyphs).length] ?? "";
        outRows.push(fit(s.spin.split("{g}").join(glyph).split("{t}").join(fmtElapsed()), width));
      } else {
        outRows.push(fit(row, width));
      }
    }
    return outRows;
  };

  let spinRow = -1;
  const SYNC_ON = ESC + "[?2026h";
  const SYNC_OFF = ESC + "[?2026l";
  const draw = () => {
    const width = Math.max(40, process.stdout.columns || 80);
    const height = Math.max(8, process.stdout.rows || 24);
    const source = phase === "boot" ? s.boot : phase === "work" ? s.work : (s.settled ?? s.work);
    const full = expand(source, width);
    const fullLength = full.length;
    const spinIndex = lastSpinIndex;
    const rows = full.slice(-height);
    // A block cut by the top edge leaves an orphaned continuation row (a box's
    // side, a tool result's "⎿"); blank those so the frame starts on a whole
    // block, as a scrolled session's first visible line usually does.
    for (let i = 0; i < rows.length; i++) {
      const plain = (rows[i] as string).replace(ANSI, "");
      if (plain !== "" && /^ ?\S/.test(plain) && !/^[│╰]/.test(plain)) break;
      rows[i] = "";
    }
    spinRow = phase === "work" && spinIndex >= 0 ? spinIndex - (fullLength - rows.length) : -1;
    // One synchronized frame, so a capture never lands on a half-drawn screen.
    write(SYNC_ON + ESC + "[?25l" + ESC + "[H" + ESC + "[2J" + rows.join("\r\n") + SYNC_OFF);
  };

  /** Repaint only the status row, the way a real spinner ticks. */
  const tickSpinner = () => {
    if (spinRow < 0) return;
    const width = Math.max(40, process.stdout.columns || 80);
    const line = expand(["@spin"], width)[0] ?? "";
    write(
      SYNC_ON +
        ESC +
        "7" +
        ESC +
        "[" +
        (spinRow + 1) +
        ";1H" +
        ESC +
        "[2K" +
        line +
        ESC +
        "8" +
        SYNC_OFF
    );
  };

  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(nodePath.join(config.stateDir, entry.key + ".pid"), String(process.pid));
  } catch {
    // The marker is for the spec; the screen is what matters.
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    if (chunk.toString("utf8").includes("\u0003")) {
      write(ESC + "[?25h" + ESC + "[2J" + ESC + "[H");
      process.exit(0);
    }
  });

  write(ESC + "]0;" + s.title + "\u0007");
  draw();

  setTimeout(() => {
    phase = "work";
    workStarted = Date.now();
    draw();
    const timer = setInterval(() => {
      tick += 1;
      write(OSC_WORKING);
      tickSpinner();
    }, 500);
    write(OSC_WORKING);
    if (typeof s.workMs === "number") {
      setTimeout(() => {
        clearInterval(timer);
        phase = "settled";
        write(OSC_IDLE);
        draw();
      }, s.workMs);
    }
  }, 1500);

  let redraw: ReturnType<typeof setTimeout> | null = null;
  process.stdout.on("resize", () => {
    if (redraw !== null) clearTimeout(redraw);
    redraw = setTimeout(draw, 150);
  });
  setInterval(() => {}, 1000);
}

function installFakeCli(
  binDir: string,
  stateDir: string,
  command: string,
  scripts: FakeCliConfig["scripts"]
): void {
  mkdirSync(binDir, { recursive: true });
  const config: FakeCliConfig = { scripts, stateDir };
  const node = process.execPath;
  const shebang = /^[^\s]{1,120}$/.test(node) ? `#!${node}` : "#!/usr/bin/env node";
  const file = path.join(binDir, command);
  writeFileSync(
    file,
    [
      shebang,
      `(${fakeCliProgram.toString()})(${JSON.stringify(config)}, require("fs"), require("path"));`,
      "",
    ].join("\n")
  );
  chmodSync(file, 0o755);
}

// ---------------------------------------------------------------------------
// The sessions on screen
// ---------------------------------------------------------------------------

const E = "\u001b[";
const R = `${E}0m`;
const B = `${E}1m`;
const RED = `${E}31m`;
const GREEN = `${E}32m`;
const YELLOW = `${E}33m`;
const BLUE = `${E}34m`;
const MAGENTA = `${E}35m`;
const CYAN = `${E}36m`;
const GREY = `${E}90m`;
const CLAUDE = `${E}38;2;215;119;87m`;

const WT = "~/code/atlas-ledger-worktrees";

function claudeScript(): FakeCliScript {
  const header = [
    ` ${CLAUDE}▐▛███▜▌${R}   ${B}Claude Code${R} v2.4.12`,
    `${CLAUDE}▝▜█████▛▘${R}  ${GREY}Opus 5.5 · Claude Max${R}`,
    `  ${CLAUDE}▘▘ ▝▝${R}    ${GREY}${WT}/settlement-export${R}`,
    "",
  ];
  const body = [
    ...header,
    `${GREY}>${R} Add a CSV export for daily settlements, grouped by merchant, amounts in`,
    `  minor units. Stream it so a month of payouts never sits in memory.`,
    "",
    `${GREEN}⏺${R} ${B}Read${R}(src/export/settlement.ts)`,
    `  ${GREY}⎿  Read 86 lines${R}`,
    "",
    `${GREEN}⏺${R} ${B}Search${R}(pattern: "settlementsForRange", path: "src")`,
    `  ${GREY}⎿  Found 3 files${R}`,
    "",
    `${GREEN}⏺${R} ${B}Update${R}(src/export/settlement.ts)`,
    `  ${GREY}⎿  Updated src/export/settlement.ts with ${R}${B}9${R}${GREY} additions and ${R}${B}3${R}${GREY} removals${R}`,
    `      ${GREY}41${R}   export async function exportSettlements(range: DateRange) {`,
    `      ${GREY}42${R} ${RED}-   const rows = await ledger.settlementsForRange(range);${R}`,
    `      ${GREY}43${R} ${RED}-   return rows.map(toCsvRow).join("\\n");${R}`,
    `      ${GREY}42${R} ${GREEN}+   const stream = ledger.streamSettlements(range);${R}`,
    `      ${GREY}43${R} ${GREEN}+   const csv = createCsvWriter(SETTLEMENT_COLUMNS);${R}`,
    `      ${GREY}44${R} ${GREEN}+   for await (const batch of groupByMerchant(stream)) {${R}`,
    `      ${GREY}45${R} ${GREEN}+     csv.write(batch.map(toMinorUnits));${R}`,
    `      ${GREY}46${R} ${GREEN}+   }${R}`,
    "",
    `${GREEN}⏺${R} ${B}Bash${R}(pnpm vitest run test/export)`,
    `  ${GREY}⎿${R}  ${GREEN}✓${R} test/export/settlement.test.ts ${GREY}(14 tests) 212ms${R}`,
    `     ${GREEN}✓${R} test/export/csv.test.ts ${GREY}(9 tests) 48ms${R}`,
    `     ${B}Tests${R}  ${GREEN}23 passed${R} ${GREY}(23)${R}`,
    "",
    `${GREEN}⏺${R} Tests pass. Wiring the endpoint into ${B}src/api/routes/settlements.ts${R} next.`,
    "",
    "@spin",
    "",
    "@rule:90",
    `${GREY}>${R} `,
    "@rule:90",
    `  ${MAGENTA}⏵⏵ accept edits on${R} ${GREY}(shift+tab to cycle)${R}`,
  ];
  return {
    versionText: "2.4.12 (Claude Code)",
    title: "✳ Settlement CSV export",
    boot: [...header, "@rule:90", `${GREY}>${R} `, "@rule:90", `  ${GREY}? for shortcuts${R}`],
    work: body,
    spin: `${CLAUDE}{g} Wiring the export route…${R} ${GREY}({t} · ↑ 6.1k tokens · esc to interrupt)${R}`,
    glyphs: "·✢✳✶✻✽",
    elapsedBase: 134,
  };
}

function codexScript(): FakeCliScript {
  const header = [
    "@box:90",
    `${B}>_ OpenAI Codex${R} ${GREY}(v0.161.0)${R}`,
    "",
    `${GREY}model:${R}     gpt-6.1-sol high   ${CYAN}/model${R}${GREY} to change${R}`,
    `${GREY}directory:${R} ${WT}/fx-rounding`,
    "@endbox",
    "",
  ];
  const footer = [
    "",
    `${CYAN}›${R} ${GREY}Ask Codex to do anything${R}`,
    "",
    `@lr:  ${GREY}⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit${R}\t${GREY}74% context left${R}`,
  ];
  return {
    versionText: "codex-cli 0.161.0",
    title: "Fix JPY rounding",
    boot: [...header, ...footer],
    work: [
      ...header,
      `${CYAN}›${R} JPY payouts drift by ¥1 on large transfers. Find the rounding bug in`,
      `  src/fx and fix it with banker's rounding on ISO 4217 minor units.`,
      "",
      `${GREY}•${R} ${B}Explored${R}`,
      `  ${GREY}└${R} ${CYAN}Search${R} roundHalfEven|Math.round in src/fx`,
      `    ${CYAN}Read${R} convert.ts, rounding.ts, currencies.ts`,
      "",
      `${GREY}•${R} convert() multiplies floats before rounding, so yen amounts lose a unit`,
      `  past 2^53 / 100. Moving the math to bigint minor units.`,
      "",
      `${GREY}•${R} ${B}Edited${R} src/fx/convert.ts ${GREY}(${R}${GREEN}+7${R} ${RED}-4${R}${GREY})${R}`,
      `    ${GREY}27${R} ${RED}-  const raw = amount * rate.value;${R}`,
      `    ${GREY}28${R} ${RED}-  return Math.round(raw * 100) / 100;${R}`,
      `    ${GREY}27${R} ${GREEN}+  const minor = toMinorUnits(amount, from);${R}`,
      `    ${GREY}28${R} ${GREEN}+  const scaled = mulDiv(minor, rate.num, rate.den);${R}`,
      `    ${GREY}29${R} ${GREEN}+  return fromMinorUnits(roundHalfEven(scaled), to);${R}`,
      "",
      `${GREY}•${R} ${B}Ran${R} pnpm vitest run test/fx`,
      `  ${GREY}└${R} ${GREEN}✓${R} test/fx/convert.test.ts ${GREY}(31 tests) 87ms${R}`,
      `    ${GREEN}✓${R} test/fx/rounding.test.ts ${GREY}(11 tests) 22ms${R}`,
      `    ${B}Tests${R}  ${GREEN}42 passed${R} ${GREY}(42)${R}`,
      "",
      "@spin",
      ...footer,
    ],
    spin: `${GREY}{g}${R} ${B}Running pnpm tsc --noEmit${R} ${GREY}({t} • esc to interrupt)${R}`,
    glyphs: "•◦",
    elapsedBase: 38,
  };
}

function antigravityScript(): FakeCliScript {
  const header = [
    ` ${BLUE}▲${R} ${B}Antigravity${R} ${GREY}v1.2.4${R}`,
    ` ${GREY}${WT}/matcher${R}`,
    "",
  ];
  const turn = [
    `${GREY}>${R} Split the reconciliation matcher into exact, fuzzy and split-payment`,
    `  passes. Keep the public API identical and every fixture passing.`,
    "",
    `${BLUE}✦${R} matchTransactions() is one 340-line function with three strategies`,
    `  interleaved. Each pass becomes its own module behind a MatchPass interface.`,
    "",
    `  ${GREEN}✓${R} ${B}ReadFile${R} src/reconcile/matcher.ts`,
    `  ${GREEN}✓${R} ${B}ReadFile${R} src/reconcile/rules.ts`,
    `  ${GREEN}✓${R} ${B}WriteFile${R} src/reconcile/passes/exact.ts ${GREEN}+48${R}`,
    `  ${GREEN}✓${R} ${B}WriteFile${R} src/reconcile/passes/fuzzy.ts ${GREEN}+71${R}`,
    `  ${GREEN}✓${R} ${B}Edit${R} src/reconcile/matcher.ts ${GREEN}+22${R} ${RED}-214${R}`,
    `  ${GREEN}✓${R} ${B}Shell${R} pnpm vitest run test/reconcile ${GREY}· 42 passed${R}`,
    "",
  ];
  const model = `${GREY}Gemini 3.7 Pro · high${R}`;
  return {
    versionText: "1.2.4",
    title: "Split matcher passes",
    boot: [
      ...header,
      "@boxfull:90",
      `${GREY}>${R} `,
      "@endbox",
      `@lr: ${GREY}? for shortcuts${R}\t${model}`,
    ],
    work: [
      ...header,
      ...turn,
      "@spin",
      "",
      "@boxfull:90",
      `${GREY}>${R} `,
      "@endbox",
      `@lr: ${GREY}esc to cancel${R}\t${model}`,
    ],
    settled: [
      ...header,
      ...turn,
      "@boxfull:33",
      `${YELLOW}${B}Requesting permission for:${R} Shell`,
      "",
      `  ${CYAN}git mv${R} src/reconcile/legacy.ts src/reconcile/passes/split.ts`,
      "",
      `Do you want to proceed?`,
      `${BLUE}>${R} ${B}1. Yes, allow once${R}`,
      `  2. Yes, always allow git mv in this project`,
      `  3. No, suggest changes ${GREY}(esc)${R}`,
      "@endbox",
      `@lr: ${GREY}↑/↓ Navigate · enter Select · shift+tab to auto-approve${R}\t${model}`,
    ],
    workMs: 5000,
    spin: `${BLUE}{g}${R}  Moving the split-payment pass out of legacy.ts`,
    glyphs: "⣷⣯⣟⡿⢿⣻⣽⣾",
    elapsedBase: 0,
  };
}

function opencodeScript(): FakeCliScript {
  const header = [` ${B}opencode${R} ${GREY}1.4.9${R}`, ` ${GREY}${WT}/reconcile-fixtures${R}`, ""];
  const prompt = [
    `${CYAN}┃${R} Generate October fixtures for the reconciler: a bank statement and the`,
    `${CYAN}┃${R} matching ledger, with refunds, partial captures and one FX settlement.`,
    "",
    `  ${GREY}→${R} ${B}Read${R} test/reconcile/matcher.test.ts`,
    `  ${GREY}→${R} ${B}Glob${R} test/fixtures/**/*.json ${GREY}(6 files)${R}`,
    `  ${GREEN}←${R} ${B}Write${R} test/fixtures/bank-statement-2026-10.csv ${GREEN}+184${R}`,
    `  ${GREEN}←${R} ${B}Write${R} test/fixtures/ledger-2026-10.json ${GREEN}+412${R}`,
    `  ${GREEN}←${R} ${B}Edit${R} test/reconcile/matcher.test.ts ${GREEN}+38${R} ${RED}-2${R}`,
    `  ${YELLOW}$${R} ${B}pnpm vitest run test/reconcile${R}`,
    "",
  ];
  const input = [
    "",
    "@boxfull:36",
    `${GREY}Ask anything…${R}`,
    "@endbox",
    `@lr:  ${CYAN}Build${R} ${GREY}anthropic/claude-sonnet-5${R}\t${GREY}ctrl+p commands${R}`,
  ];
  return {
    versionText: "1.4.9",
    title: "October reconcile fixtures",
    boot: [...header, ...input],
    work: [...header, ...prompt, "@spin", ...input],
    settled: [
      ...header,
      ...prompt,
      `     ${GREEN}✓${R} test/reconcile/matcher.test.ts ${GREY}(42 tests) 318ms${R}`,
      `     ${GREEN}✓${R} test/reconcile/rules.test.ts ${GREY}(17 tests) 41ms${R}`,
      `     ${B}Tests${R}  ${GREEN}59 passed${R} ${GREY}(59)${R}`,
      "",
      `  Added three fixture sets: refunds, partial captures and a EUR→GBP`,
      `  settlement. All 59 reconcile tests pass, committed in four commits.`,
      "",
      `  ${GREY}3 files changed, +634 -2 · 1m 48s${R}`,
      ...input,
    ],
    workMs: 6000,
    spin: `  ${CYAN}{g}${R} Generating… ${GREY}(esc to interrupt)${R}`,
    glyphs: "⣾⣽⣻⢿⡿⣟⣯⣷",
    elapsedBase: 0,
  };
}

function claudeDepsScript(): FakeCliScript {
  const header = [
    ` ${CLAUDE}▐▛███▜▌${R}   ${B}Claude Code${R} v2.4.12`,
    `${CLAUDE}▝▜█████▛▘${R}  ${GREY}Opus 5.5 · Claude Max${R}`,
    `  ${CLAUDE}▘▘ ▝▝${R}    ${GREY}${WT}/deps${R}`,
    "",
  ];
  const turn = [
    `${GREY}>${R} Bump fastify and vitest to their latest minors and check the changelogs`,
    `  for anything that affects us.`,
    "",
    `${GREEN}⏺${R} ${B}Bash${R}(pnpm outdated --format json)`,
    `  ${GREY}⎿  fastify 5.4.0 → 5.6.1, vitest 4.0.3 → 4.0.8${R}`,
    "",
    `${GREEN}⏺${R} ${B}Fetch${R}(https://github.com/fastify/fastify/releases/tag/v5.6.0)`,
    `  ${GREY}⎿  Received 41.2KB (200 OK)${R}`,
    "",
  ];
  const box = ["@rule:90", `${GREY}>${R} `, "@rule:90", `  ${GREY}? for shortcuts${R}`];
  return {
    versionText: "2.4.12 (Claude Code)",
    title: "✳ Dependency bumps",
    boot: [...header, ...box],
    work: [...header, ...turn, "@spin", "", ...box],
    settled: [
      ...header,
      ...turn,
      `${GREEN}⏺${R} Fastify 5.6 drops Node 20, and our Dockerfile still pins ${B}node:20-slim${R}.`,
      `  Should I move the image and ${B}engines${R} to Node 22, or hold fastify at 5.5`,
      `  until the infra upgrade lands?`,
      "",
      ...box,
    ],
    workMs: 4000,
    spin: `${CLAUDE}{g} Reading the changelog…${R} ${GREY}({t} · esc to interrupt)${R}`,
    glyphs: "·✢✳✶✻✽",
    elapsedBase: 12,
  };
}

interface StagedAgent {
  key: string;
  agentId: string;
  command: string;
  branch: string;
  /** States the hero accepts for this pane. */
  expect: string[];
  script: () => FakeCliScript;
  /** In the hero fleet; the rest launch afterwards for the Pilot view. */
  hero: boolean;
}

/** Fleet order is grid order: top-left, top-right, bottom-left, bottom-right. */
const STAGED: StagedAgent[] = [
  {
    key: "claude",
    agentId: "claude",
    command: "claude",
    branch: "feature/settlement-export",
    expect: ["working"],
    script: claudeScript,
    hero: true,
  },
  {
    key: "antigravity",
    agentId: "antigravity",
    command: "agy",
    branch: "refactor/matcher",
    expect: ["waiting"],
    script: antigravityScript,
    hero: true,
  },
  {
    key: "opencode",
    agentId: "opencode",
    command: "opencode",
    branch: "test/reconcile-fixtures",
    expect: ["completed", "idle", "waiting"],
    script: opencodeScript,
    hero: true,
  },
  {
    key: "codex",
    agentId: "codex",
    command: "codex",
    branch: "fix/fx-rounding",
    expect: ["working"],
    script: codexScript,
    hero: true,
  },
  {
    key: "claude-deps",
    agentId: "claude",
    command: "claude",
    branch: "chore/deps",
    expect: ["waiting"],
    script: claudeDepsScript,
    hero: false,
  },
];
const HERO = STAGED.filter((a) => a.hero);

// ---------------------------------------------------------------------------
// The project on disk
// ---------------------------------------------------------------------------

const BASE_FILES: Record<string, string> = {
  "package.json":
    JSON.stringify(
      {
        name: "atlas-ledger",
        version: "0.18.2",
        private: true,
        type: "module",
        scripts: {
          dev: "tsx watch src/index.ts",
          build: "tsc -p tsconfig.json",
          test: "vitest run",
          typecheck: "tsc --noEmit",
        },
        dependencies: { fastify: "^5.4.0", pino: "^9.7.0", zod: "^4.1.0" },
        devDependencies: { typescript: "^6.0.2", tsx: "^4.20.0", vitest: "^4.0.3" },
      },
      null,
      2
    ) + "\n",
  "tsconfig.json":
    '{\n  "compilerOptions": {\n    "target": "ES2023",\n    "module": "NodeNext",\n    "strict": true,\n    "outDir": "dist"\n  },\n  "include": ["src"]\n}\n',
  ".gitignore": "node_modules\ndist\ncoverage\n.env\n",
  "README.md":
    "# Atlas Ledger\n\nDouble-entry ledger, FX conversion and bank reconciliation behind Atlas payouts.\n\n```sh\npnpm install\npnpm dev\n```\n",
  "vitest.config.ts":
    'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"] } });\n',
  "src/index.ts":
    'import { buildServer } from "./api/server.js";\n\nconst server = await buildServer();\nawait server.listen({ port: Number(process.env.PORT ?? 4100) });\n',
  "src/ledger/accounts.ts":
    'export type AccountKind = "asset" | "liability" | "revenue" | "expense";\n\nexport interface Account {\n  id: string;\n  kind: AccountKind;\n  currency: string;\n}\n',
  "src/ledger/journal.ts":
    'import type { Posting } from "./posting.js";\n\nexport interface JournalEntry {\n  id: string;\n  postedAt: Date;\n  postings: Posting[];\n}\n\nexport function isBalanced(entry: JournalEntry): boolean {\n  return entry.postings.reduce((sum, p) => sum + p.amountMinor, 0n) === 0n;\n}\n',
  "src/ledger/posting.ts":
    "export interface Posting {\n  accountId: string;\n  amountMinor: bigint;\n  currency: string;\n}\n",
  "src/fx/currencies.ts":
    "export const MINOR_UNITS: Record<string, number> = { USD: 2, EUR: 2, GBP: 2, JPY: 0, KWD: 3 };\n",
  "src/fx/rates.ts":
    "export interface Rate {\n  from: string;\n  to: string;\n  value: number;\n  asOf: Date;\n}\n",
  "src/fx/rounding.ts":
    "export function roundHalfUp(value: number, places: number): number {\n  const factor = 10 ** places;\n  return Math.round(value * factor) / factor;\n}\n",
  "src/fx/convert.ts": [
    'import type { Rate } from "./rates.js";',
    "",
    "export function convert(amount: number, rate: Rate): number {",
    "  const raw = amount * rate.value;",
    "  return Math.round(raw * 100) / 100;",
    "}",
    "",
  ].join("\n"),
  "src/reconcile/rules.ts":
    'export interface MatchRule {\n  name: string;\n  toleranceMinor: bigint;\n  windowDays: number;\n}\n\nexport const DEFAULT_RULES: MatchRule[] = [\n  { name: "exact", toleranceMinor: 0n, windowDays: 2 },\n  { name: "fuzzy", toleranceMinor: 100n, windowDays: 5 },\n];\n',
  "src/reconcile/matcher.ts": [
    'import { DEFAULT_RULES, type MatchRule } from "./rules.js";',
    'import type { BankLine, LedgerLine, Match } from "./types.js";',
    "",
    "export function matchTransactions(",
    "  bank: BankLine[],",
    "  ledger: LedgerLine[],",
    "  rules: MatchRule[] = DEFAULT_RULES",
    "): Match[] {",
    "  const matches: Match[] = [];",
    "  for (const line of bank) {",
    "    const candidate = ledger.find((l) => l.amountMinor === line.amountMinor);",
    "    if (candidate) matches.push({ bank: line, ledger: candidate, rule: rules[0]!.name });",
    "  }",
    "  return matches;",
    "}",
    "",
  ].join("\n"),
  "src/reconcile/types.ts":
    "export interface BankLine {\n  id: string;\n  amountMinor: bigint;\n  bookedAt: Date;\n  reference: string;\n}\n\nexport interface LedgerLine {\n  id: string;\n  amountMinor: bigint;\n  postedAt: Date;\n}\n\nexport interface Match {\n  bank: BankLine;\n  ledger: LedgerLine;\n  rule: string;\n}\n",
  "src/reconcile/legacy.ts":
    "// Split-payment matching, still inlined from the v1 reconciler.\nexport function matchSplitPayments(): never[] {\n  return [];\n}\n",
  "src/export/settlement.ts": [
    'import { ledger } from "../ledger/index.js";',
    'import type { DateRange } from "../types.js";',
    "",
    "export interface SettlementRow {",
    "  merchantId: string;",
    "  currency: string;",
    "  grossMinor: bigint;",
    "  feesMinor: bigint;",
    "}",
    "",
    "function toCsvRow(row: SettlementRow): string {",
    '  return [row.merchantId, row.currency, row.grossMinor, row.feesMinor].join(",");',
    "}",
    "",
    "export async function exportSettlements(range: DateRange): Promise<string> {",
    "  const rows = await ledger.settlementsForRange(range);",
    '  return rows.map(toCsvRow).join("\\n");',
    "}",
    "",
  ].join("\n"),
  "src/api/server.ts":
    'import Fastify from "fastify";\nimport { settlementRoutes } from "./routes/settlements.js";\n\nexport async function buildServer() {\n  const app = Fastify({ logger: true });\n  await app.register(settlementRoutes, { prefix: "/v1/settlements" });\n  return app;\n}\n',
  "src/api/routes/settlements.ts":
    'import type { FastifyPluginAsync } from "fastify";\n\nexport const settlementRoutes: FastifyPluginAsync = async (app) => {\n  app.get("/", async () => ({ data: [] }));\n};\n',
  "test/fx/convert.test.ts":
    'import { describe, expect, it } from "vitest";\nimport { convert } from "../../src/fx/convert.js";\n\ndescribe("convert", () => {\n  it("converts USD to EUR", () => {\n    expect(convert(100, { from: "USD", to: "EUR", value: 0.92, asOf: new Date() })).toBe(92);\n  });\n});\n',
  "test/reconcile/matcher.test.ts":
    'import { describe, expect, it } from "vitest";\nimport { matchTransactions } from "../../src/reconcile/matcher.js";\n\ndescribe("matchTransactions", () => {\n  it("matches exact amounts", () => {\n    expect(matchTransactions([], [])).toEqual([]);\n  });\n});\n',
  "test/export/settlement.test.ts":
    'import { describe, expect, it } from "vitest";\n\ndescribe("exportSettlements", () => {\n  it.todo("groups rows by merchant");\n});\n',
  "test/fixtures/bank-statement-2026-09.csv":
    "booked_at,reference,amount,currency\n2026-09-01,PAYOUT-88213,1520.00,USD\n2026-09-01,PAYOUT-88214,98000,JPY\n",
  "docs/architecture.md":
    "# Architecture\n\nPostings are immutable; corrections are new journal entries. FX runs on minor units.\n",
};

const EXPORT_SETTLEMENT_DIRTY = [
  'import { ledger } from "../ledger/index.js";',
  'import { createCsvWriter, type CsvColumn } from "./csv.js";',
  'import type { DateRange } from "../types.js";',
  "",
  "export interface SettlementRow {",
  "  merchantId: string;",
  "  currency: string;",
  "  grossMinor: bigint;",
  "  feesMinor: bigint;",
  "  netMinor: bigint;",
  "}",
  "",
  "export const SETTLEMENT_COLUMNS: CsvColumn<SettlementRow>[] = [",
  '  { header: "merchant_id", value: (r) => r.merchantId },',
  '  { header: "currency", value: (r) => r.currency },',
  '  { header: "gross_minor", value: (r) => r.grossMinor },',
  '  { header: "fees_minor", value: (r) => r.feesMinor },',
  '  { header: "net_minor", value: (r) => r.netMinor },',
  "];",
  "",
  "/** Streams one merchant's rows at a time so a month of payouts never sits in memory. */",
  "export async function* exportSettlements(range: DateRange): AsyncGenerator<string> {",
  "  const csv = createCsvWriter(SETTLEMENT_COLUMNS);",
  "  yield csv.header();",
  "  for await (const batch of groupByMerchant(ledger.streamSettlements(range))) {",
  "    yield csv.rows(batch.map(withNet));",
  "  }",
  "}",
  "",
  'function withNet(row: Omit<SettlementRow, "netMinor">): SettlementRow {',
  "  return { ...row, netMinor: row.grossMinor - row.feesMinor };",
  "}",
  "",
].join("\n");

interface Worktree {
  branch: string;
  slug: string;
  commits: Array<{ message: string; files: Record<string, string>; hoursAgo: number }>;
  dirty: Record<string, string | null>;
  /** Push to origin with upstream after this many commits; omit to stay local. */
  pushAfter?: number;
}

const WORKTREES: Worktree[] = [
  {
    branch: "feature/settlement-export",
    pushAfter: 2,
    slug: "settlement-export",
    commits: [
      {
        message: "feat(export): add streaming CSV writer",
        hoursAgo: 5,
        files: {
          "src/export/csv.ts":
            'export interface CsvColumn<T> {\n  header: string;\n  value: (row: T) => string | bigint | number;\n}\n\nexport function createCsvWriter<T>(columns: CsvColumn<T>[]) {\n  const escape = (v: unknown) => {\n    const s = String(v);\n    return /[",\\n]/.test(s) ? `"${s.replace(/"/g, \'""\')}"` : s;\n  };\n  return {\n    header: () => columns.map((c) => c.header).join(",") + "\\n",\n    rows: (rows: T[]) => rows.map((r) => columns.map((c) => escape(c.value(r))).join(",")).join("\\n") + "\\n",\n  };\n}\n',
        },
      },
      {
        message: "test(export): cover quoting and minor units",
        hoursAgo: 3,
        files: {
          "test/export/csv.test.ts":
            'import { describe, expect, it } from "vitest";\nimport { createCsvWriter } from "../../src/export/csv.js";\n\ndescribe("createCsvWriter", () => {\n  it("quotes commas", () => {\n    const csv = createCsvWriter<{ name: string }>([{ header: "name", value: (r) => r.name }]);\n    expect(csv.rows([{ name: "Acme, Inc" }])).toBe(\'"Acme, Inc"\\n\');\n  });\n});\n',
        },
      },
      {
        message: "feat(ledger): stream settlements by range",
        hoursAgo: 1,
        files: {
          "src/ledger/index.ts":
            "export const ledger = {\n  async *streamSettlements(_range: unknown) {},\n  async settlementsForRange(_range: unknown) {\n    return [];\n  },\n};\n",
        },
      },
    ],
    dirty: {
      "src/export/settlement.ts": EXPORT_SETTLEMENT_DIRTY,
      "test/export/settlement.test.ts":
        'import { describe, expect, it } from "vitest";\nimport { exportSettlements } from "../../src/export/settlement.js";\n\ndescribe("exportSettlements", () => {\n  it("writes the header first", async () => {\n    const first = await exportSettlements({ from: new Date(), to: new Date() }).next();\n    expect(first.value).toMatch(/^merchant_id,currency/);\n  });\n\n  it("computes net from gross and fees", async () => {\n    expect(true).toBe(true);\n  });\n});\n',
      "src/api/routes/settlements.ts":
        'import type { FastifyPluginAsync } from "fastify";\nimport { exportSettlements } from "../../export/settlement.js";\n\nexport const settlementRoutes: FastifyPluginAsync = async (app) => {\n  app.get("/", async () => ({ data: [] }));\n  app.get("/export.csv", async (req, reply) => {\n    reply.type("text/csv");\n    return reply.send(exportSettlements(parseRange(req.query)));\n  });\n};\n',
    },
  },
  {
    branch: "fix/fx-rounding",
    pushAfter: 1,
    slug: "fx-rounding",
    commits: [
      {
        message: "test(fx): reproduce JPY drift on large transfers",
        hoursAgo: 2,
        files: {
          "test/fx/rounding.test.ts":
            'import { describe, expect, it } from "vitest";\n\ndescribe("roundHalfEven", () => {\n  it("rounds ties to even", () => {\n    expect(Math.round(2.5)).toBe(3);\n  });\n});\n',
        },
      },
    ],
    dirty: {
      "src/fx/convert.ts": [
        'import { MINOR_UNITS } from "./currencies.js";',
        'import type { Rate } from "./rates.js";',
        'import { roundHalfEven, mulDiv } from "./rounding.js";',
        "",
        "export function convert(amountMinor: bigint, rate: Rate): bigint {",
        "  const scale = 10n ** BigInt(MINOR_UNITS[rate.to] ?? 2);",
        "  const scaled = mulDiv(amountMinor * scale, rate.num, rate.den);",
        "  return roundHalfEven(scaled, scale);",
        "}",
        "",
      ].join("\n"),
      "src/fx/rounding.ts":
        "export function mulDiv(value: bigint, num: bigint, den: bigint): bigint {\n  return (value * num) / den;\n}\n\nexport function roundHalfEven(value: bigint, scale: bigint): bigint {\n  const q = value / scale;\n  const r = value % scale;\n  const twice = r * 2n;\n  if (twice > scale || (twice === scale && q % 2n !== 0n)) return q + 1n;\n  return q;\n}\n",
    },
  },
  {
    branch: "refactor/matcher",
    pushAfter: 2,
    slug: "matcher",
    commits: [
      {
        message: "refactor(reconcile): introduce MatchPass interface",
        hoursAgo: 6,
        files: {
          "src/reconcile/passes/types.ts":
            'import type { BankLine, LedgerLine, Match } from "../types.js";\n\nexport interface MatchPass {\n  name: string;\n  run(bank: BankLine[], ledger: LedgerLine[]): Match[];\n}\n',
        },
      },
      {
        message: "refactor(reconcile): extract exact pass",
        hoursAgo: 4,
        files: {
          "src/reconcile/passes/exact.ts":
            'import type { MatchPass } from "./types.js";\n\nexport const exactPass: MatchPass = {\n  name: "exact",\n  run(bank, ledger) {\n    return bank.flatMap((b) => {\n      const l = ledger.find((x) => x.amountMinor === b.amountMinor);\n      return l ? [{ bank: b, ledger: l, rule: "exact" }] : [];\n    });\n  },\n};\n',
        },
      },
    ],
    dirty: {
      "src/reconcile/passes/fuzzy.ts":
        'import type { MatchPass } from "./types.js";\n\nconst DAY = 86_400_000;\n\nexport const fuzzyPass: MatchPass = {\n  name: "fuzzy",\n  run(bank, ledger) {\n    return bank.flatMap((b) => {\n      const l = ledger.find(\n        (x) =>\n          (x.amountMinor - b.amountMinor < 100n && b.amountMinor - x.amountMinor < 100n) &&\n          Math.abs(x.postedAt.getTime() - b.bookedAt.getTime()) < 5 * DAY\n      );\n      return l ? [{ bank: b, ledger: l, rule: "fuzzy" }] : [];\n    });\n  },\n};\n',
      "src/reconcile/matcher.ts": [
        'import { exactPass } from "./passes/exact.js";',
        'import { fuzzyPass } from "./passes/fuzzy.js";',
        'import type { BankLine, LedgerLine, Match } from "./types.js";',
        "",
        "const PASSES = [exactPass, fuzzyPass];",
        "",
        "export function matchTransactions(bank: BankLine[], ledger: LedgerLine[]): Match[] {",
        "  const matched = new Set<string>();",
        "  const out: Match[] = [];",
        "  for (const pass of PASSES) {",
        "    const open = bank.filter((b) => !matched.has(b.id));",
        "    for (const m of pass.run(open, ledger)) {",
        "      matched.add(m.bank.id);",
        "      out.push(m);",
        "    }",
        "  }",
        "  return out;",
        "}",
        "",
      ].join("\n"),
    },
  },
  {
    branch: "test/reconcile-fixtures",
    pushAfter: 4,
    slug: "reconcile-fixtures",
    commits: [
      {
        message: "test(fixtures): add October bank statement",
        hoursAgo: 0.6,
        files: {
          "test/fixtures/bank-statement-2026-10.csv":
            "booked_at,reference,amount,currency\n2026-10-01,PAYOUT-90112,2210.40,USD\n2026-10-02,REFUND-1182,-49.00,USD\n2026-10-03,PAYOUT-90140,182000,JPY\n2026-10-04,PAYOUT-90151,1290.15,EUR\n",
        },
      },
      {
        message: "test(fixtures): add matching October ledger",
        hoursAgo: 0.5,
        files: {
          "test/fixtures/ledger-2026-10.json":
            JSON.stringify(
              {
                entries: [
                  { id: "je_90112", amountMinor: "221040", currency: "USD" },
                  { id: "je_r1182", amountMinor: "-4900", currency: "USD" },
                ],
              },
              null,
              2
            ) + "\n",
        },
      },
      {
        message: "test(reconcile): cover refunds and partial captures",
        hoursAgo: 0.4,
        files: {
          "test/reconcile/refunds.test.ts":
            'import { describe, it } from "vitest";\n\ndescribe("refunds", () => {\n  it.todo("matches a refund against its original capture");\n});\n',
        },
      },
      {
        message: "test(reconcile): add EUR to GBP settlement case",
        hoursAgo: 0.3,
        files: {
          "test/reconcile/fx-settlement.test.ts":
            'import { describe, it } from "vitest";\n\ndescribe("fx settlement", () => {\n  it.todo("matches a EUR capture settled in GBP");\n});\n',
        },
      },
    ],
    dirty: {},
  },
  {
    branch: "chore/deps",
    slug: "deps",
    commits: [
      {
        message: "chore(deps): bump fastify to 5.6 and vitest to 4.0.8",
        hoursAgo: 26,
        files: {
          "package.json": BASE_FILES["package.json"]!.replace("^5.4.0", "^5.6.1").replace(
            "^4.0.3",
            "^4.0.8"
          ),
        },
      },
    ],
    dirty: {},
  },
];

interface Fixture {
  root: string;
  home: string;
  repo: string;
  bin: string;
  state: string;
  cleanup: () => void;
}

function writeTree(dir: string, files: Record<string, string | null>): void {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    if (body === null) {
      rmSync(file, { force: true });
      continue;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
}

function createFixture(): Fixture {
  // Neutral prefix: launchApp's hygiene reaps processes whose command line
  // names a dir it launched, and every path here shows as ~/… in the app.
  const root = mkdtempSync(path.join(tmpdir(), "atlas-readme-"));
  const home = path.join(root, "home");
  const bin = path.join(home, ".local", "bin");
  const state = path.join(root, "agent-state");
  for (const dir of [
    bin,
    state,
    path.join(home, ".config", "opencode"),
    path.join(home, ".local", "share"),
    path.join(home, ".local", "state"),
    path.join(home, ".cache"),
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    path.join(home, ".gemini"),
    path.join(home, "code"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const rc of [".zshrc", ".zshenv", ".bashrc"]) writeFileSync(path.join(home, rc), "");
  const profile = pathRestoreProfile([bin, ...(process.env.PATH ?? "").split(path.delimiter)]);
  for (const rc of [".zprofile", ".bash_profile", ".profile"])
    writeFileSync(path.join(home, rc), profile);
  writeFileSync(path.join(home, ".hushlogin"), "");
  // Sign-in markers the availability probe looks for, in this throwaway HOME.
  writeFileSync(path.join(home, ".claude.json"), "{}\n");
  writeFileSync(path.join(home, ".codex", "auth.json"), "{}\n");
  writeFileSync(path.join(home, ".gemini", "oauth_creds.json"), "{}\n");
  writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), "{}\n");
  writeFileSync(
    path.join(home, ".gitconfig"),
    "[user]\n\tname = Priya Raman\n\temail = priya@atlasledger.dev\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n"
  );

  const now = Date.now();
  const git = (args: string[], cwd: string, hoursAgo?: number, author?: string) => {
    const when =
      hoursAgo === undefined ? undefined : new Date(now - hoursAgo * 3_600_000).toISOString();
    execFileSync("git", author ? ["-c", `user.name=${author}`, ...args] : args, {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}),
      },
    });
  };

  const repo = path.join(home, "code", "atlas-ledger");
  const wtRoot = path.join(home, "code", "atlas-ledger-worktrees");
  mkdirSync(repo, { recursive: true });
  mkdirSync(wtRoot, { recursive: true });
  git(["init", "-b", "main"], repo);

  const history: Array<{
    message: string;
    hoursAgo: number;
    author: string;
    pick: (f: string) => boolean;
  }> = [
    {
      message: "chore: scaffold ledger service",
      hoursAgo: 340,
      author: "Priya Raman",
      pick: (f) => !f.startsWith("src/") && !f.startsWith("test/") && !f.startsWith("docs/"),
    },
    {
      message: "feat(ledger): double-entry journal and postings",
      hoursAgo: 300,
      author: "Priya Raman",
      pick: (f) => f.startsWith("src/ledger/") || f === "src/index.ts",
    },
    {
      message: "feat(fx): currency conversion with daily rates",
      hoursAgo: 210,
      author: "Tomás Ortega",
      pick: (f) => f.startsWith("src/fx/") || f.startsWith("test/fx/"),
    },
    {
      message: "feat(reconcile): match bank lines to the ledger",
      hoursAgo: 150,
      author: "Priya Raman",
      pick: (f) =>
        f.startsWith("src/reconcile/") ||
        f.startsWith("test/reconcile/") ||
        f.startsWith("test/fixtures/"),
    },
    {
      message: "feat(api): settlements endpoint and export",
      hoursAgo: 75,
      author: "Jun Watanabe",
      pick: (f) =>
        f.startsWith("src/api/") || f.startsWith("src/export/") || f.startsWith("test/export/"),
    },
    {
      message: "docs: architecture notes",
      hoursAgo: 30,
      author: "Tomás Ortega",
      pick: (f) => f.startsWith("docs/"),
    },
  ];
  for (const step of history) {
    const files = Object.fromEntries(Object.entries(BASE_FILES).filter(([f]) => step.pick(f)));
    writeTree(repo, files);
    git(["add", "-A"], repo);
    git(["commit", "-m", step.message], repo, step.hoursAgo, step.author);
  }

  // A local bare origin, so branches track an upstream the way a cloned repo's do.
  const origin = path.join(root, "origin", "atlas-ledger.git");
  mkdirSync(path.dirname(origin), { recursive: true });
  git(["init", "--bare", "-b", "main", origin], root);
  git(["remote", "add", "origin", origin], repo);
  git(["push", "-u", "origin", "main"], repo);

  for (const wt of WORKTREES) {
    const dir = path.join(wtRoot, wt.slug);
    git(["worktree", "add", "-b", wt.branch, dir, "main"], repo);
    wt.commits.forEach((c, i) => {
      writeTree(dir, c.files);
      git(["add", "-A"], dir);
      git(["commit", "-m", c.message], dir, c.hoursAgo);
      if (wt.pushAfter === i + 1) git(["push", "-u", "origin", wt.branch], dir);
    });
    writeTree(dir, wt.dirty);
  }

  const byCommand = new Map<string, FakeCliConfig["scripts"]>();
  for (const agent of STAGED) {
    const slug = WORKTREES.find((w) => w.branch === agent.branch)?.slug ?? "*";
    const scripts = byCommand.get(agent.command) ?? {};
    scripts[slug] = { key: agent.key, script: agent.script() };
    byCommand.set(agent.command, scripts);
  }
  for (const [command, scripts] of byCommand) installFakeCli(bin, state, command, scripts);

  return {
    root,
    home,
    repo,
    bin,
    state,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Driving the app
// ---------------------------------------------------------------------------

async function settle(page: Page, ms = 600): Promise<void> {
  await page
    .evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    )
    .catch(() => {});
  await page.waitForTimeout(ms);
}

async function polish(page: Page): Promise<void> {
  await page.evaluate(
    ({ id, css }) => {
      document.getElementById(id)?.remove();
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css;
      document.head.appendChild(style);
    },
    { id: POLISH_ID, css: POLISH_CSS }
  );
}

async function act<T = unknown>(page: Page, id: string, args?: unknown): Promise<T> {
  const result = await dispatchAction<T>(page, id, args, { source: "user", confirmed: true });
  if (!result.ok) throw new Error(`${id} failed: ${JSON.stringify(result).slice(0, 300)}`);
  return (result as { result?: T }).result as T;
}

async function worktreeIdFor(page: Page, branch: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = await page.evaluate((b) => {
          const w = window as unknown as {
            __DAINTREE_E2E_WORKTREES__?: () => Array<{ id: string; branch?: string }>;
          };
          return w.__DAINTREE_E2E_WORKTREES__?.().find((t) => t.branch === b)?.id;
        }, branch);
        return id ?? null;
      },
      { timeout: T_LONG * 2, message: `worktree ${branch} never listed` }
    )
    .not.toBeNull();
  return id!;
}

async function ensureWindowSize(page: Page, app: AppContext["app"]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setContentSize(size.width, size.height);
  }, WINDOW);
  await expect
    .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight].join("x")), {
      timeout: T_LONG,
    })
    .toBe(`${WINDOW.width}x${WINDOW.height}`);
}

async function paneStates(
  page: Page,
  ids: Record<string, string>
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const [key, id] of Object.entries(ids)) {
    out[key] = await page
      .locator(`[data-panel-id="${id}"]`)
      .first()
      .getAttribute("data-agent-state", { timeout: 1000 })
      .catch(() => null);
  }
  return out;
}

function statesMatch(states: Record<string, string | null>): boolean {
  return HERO.every((a) => a.expect.includes(states[a.key] ?? ""));
}

/** Arm the four agents in grid order and show them as one fleet across worktrees. */
async function stageFleet(page: Page, ids: Record<string, string>): Promise<void> {
  const fleet = page.locator('[data-fleet-scope="true"]');
  const shown = await Promise.all(
    HERO.map((a) =>
      fleet
        .locator(`[data-panel-id="${ids[a.key]}"]`)
        .first()
        .isVisible()
        .catch(() => false)
    )
  );
  if (shown.every(Boolean)) return;
  await act(page, "terminal.disarmAll").catch(() => {});
  for (const agent of HERO) await act(page, "terminal.arm", { terminalId: ids[agent.key] });
  await act(page, "fleet.scope.enter");
  await fleet.waitFor({ state: "visible", timeout: T_LONG });
}

/**
 * The fleet grid floors each row at a comfortable panel height, so at
 * 1600x1000 a 2x2 fleet scrolls and the bottom pair is cut off. One real
 * Cmd-minus step at a time until the quad fits, the way a user on this window
 * size would zoom; the window and its device scale stay as specified.
 */
const FLEET_MIN_INNER_HEIGHT = 1190;
async function ensureZoom(page: Page): Promise<number> {
  for (let i = 0; i < 4; i++) {
    const height = await page.evaluate(() => window.innerHeight);
    if (height >= FLEET_MIN_INNER_HEIGHT) break;
    await act(page, "window.zoomOut");
    await settle(page, 400);
  }
  return page.evaluate(() => window.devicePixelRatio);
}

/** True when every fleet pane is fully inside the grid's viewport. */
async function fleetFits(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const grid = document.getElementById("panel-grid");
    if (!grid) return false;
    return grid.scrollHeight <= grid.clientHeight + 2;
  });
}

async function parkPointer(page: Page): Promise<void> {
  // Over the toolbar's empty middle: no hover chrome lands anywhere visible.
  await page.mouse.move(WINDOW.width / 2, 12);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test("readme showcase — hero per theme and review hub", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_README_SHOTS=1 is required for the README showcase capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_README_SHOTS=1 to capture the README showcase");
  if (!OUT || !path.isAbsolute(OUT)) {
    throw new Error("DAINTREE_CAPTURE_DIR must be an absolute path outside the repo");
  }
  if (path.resolve(OUT).startsWith(path.resolve(process.cwd()) + path.sep)) {
    throw new Error(`DAINTREE_CAPTURE_DIR must be outside the repo: ${OUT}`);
  }

  const expected = [...THEME_IDS.map((id) => `hero-${id}`), ...FEATURES];
  mkdirSync(OUT, { recursive: true });
  for (const slug of expected) rmSync(path.join(OUT, `${slug}.png`), { force: true });
  rmSync(path.join(OUT, "manifest.json"), { force: true });

  const failures = new Map<string, string>();
  const observed: Record<string, Record<string, string | null>> = {};
  const fixture = createFixture();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "atlas-readme-userdata-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      homeDir: fixture.home,
      screenshotScale: SCALE,
      windowSize: WINDOW,
      env: {
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fixture.bin,
        DAINTREE_IDENTITY_DEBUG_PASS: "1",
      },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, fixture.repo, "Atlas Ledger");
    await page.evaluate(async () => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id)
        await window.electron.project.update(cur.id, { emoji: "📒", name: "Atlas Ledger" });
    });
    await ensureWindowSize(page, ctx.app);
    // Fleet panes are input-locked (typing broadcasts), so their composers
    // would each read "Input locked"; the CLIs' own prompts carry the frame.
    await page.evaluate(() => window.electron.terminalConfig.setHybridInputEnabled(false));
    await setAppTheme(page, "daintree");
    await polish(page);
    await dismissBlockingPalette(page).catch(() => {});
    await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });

    // Launch each agent in its own worktree.
    const ids: Record<string, string> = {};
    for (const agent of HERO) {
      const worktreeId = await worktreeIdFor(page, agent.branch);
      const launched = await act<{ terminalId: string }>(page, "agent.launch", {
        agentId: agent.agentId,
        worktreeId,
        location: "grid",
        force: true,
        focusPolicy: "preserve",
      });
      if (!launched?.terminalId)
        throw new Error(`agent.launch ${agent.agentId} returned no terminal`);
      ids[agent.key] = launched.terminalId;
      await expect
        .poll(() => existsSync(path.join(fixture.state, `${agent.key}.pid`)), {
          timeout: T_LONG * 2,
          message: `${agent.command} never started`,
        })
        .toBe(true);
    }

    const stageAndWait = async (label: string): Promise<boolean> => {
      await stageFleet(page, ids);
      const deadline = Date.now() + 60_000;
      let states = await paneStates(page, ids);
      while (!statesMatch(states) && Date.now() < deadline) {
        await page.waitForTimeout(500);
        states = await paneStates(page, ids);
      }
      observed[label] = states;
      return statesMatch(states);
    };

    const shoot = async (slug: string): Promise<void> => {
      await parkPointer(page);
      await settle(page, 1200);
      const file = path.join(OUT, `${slug}.png`);
      // Raw CDP, not page.screenshot(): with the view zoomed out, Playwright
      // scales its capture by the zoom a second time and paints a shrunken
      // frame into a black canvas.
      const cdp = await page.context().newCDPSession(page);
      try {
        const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" })) as {
          data: string;
        };
        const png = Buffer.from(data, "base64");
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        const want = { width: WINDOW.width * Number(SCALE), height: WINDOW.height * Number(SCALE) };
        if (width !== want.width || height !== want.height) {
          failures.set(
            slug,
            `capture is ${width}x${height}, expected ${want.width}x${want.height}`
          );
        }
        writeFileSync(file, png);
      } finally {
        await cdp.detach().catch(() => {});
      }
      if (!existsSync(file) || statSync(file).size < 50_000) {
        failures.set(slug, "capture missing or implausibly small");
      }
    };

    for (const themeId of THEME_IDS) {
      const slug = `hero-${themeId}`;
      try {
        await setAppTheme(page, themeId);
        await polish(page);
        await dismissBlockingPalette(page).catch(() => {});
        await ensureZoom(page);
        const ok = await stageAndWait(slug);
        await settle(page, 600);
        const fits = await fleetFits(page);
        await shoot(slug);
        if (!ok) failures.set(slug, `agent states off-script: ${JSON.stringify(observed[slug])}`);
        else if (!fits) failures.set(slug, "fleet grid overflows: bottom panes are cut off");
        console.log(
          `[readme] ${slug} ${ok ? "ok" : "STATES OFF"} ${JSON.stringify(observed[slug])}`
        );
      } catch (error) {
        failures.set(slug, String(error).slice(0, 300));
        console.warn(`[readme] ${slug} failed:`, String(error).slice(0, 300));
      }
    }

    // ---- Feature stills -------------------------------------------------
    const escape = async (times = 3) => {
      for (let i = 0; i < times; i++) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(150);
      }
    };
    const enterTheme = async (themeId: string, zoomed: boolean) => {
      await setAppTheme(page, themeId);
      await polish(page);
      await dismissBlockingPalette(page).catch(() => {});
      if (zoomed) await ensureZoom(page);
      else await act(page, "window.zoomReset").catch(() => {});
      await settle(page, 600);
    };
    const backToFleet = async (themeId: string, zoomed = true) => {
      await enterTheme(themeId, zoomed);
      const ok = await stageAndWait(`backdrop-${themeId}`);
      if (!ok)
        console.warn(
          `[readme] backdrop for ${themeId} off-script`,
          observed[`backdrop-${themeId}`]
        );
    };
    const featureSteps: Record<FeatureShot, () => Promise<boolean>> = {
      "pilot-fiordland": async () => {
        // A fifth agent, asked a question and parked by the user, so Pilot
        // shows the parked band beside working, waiting and finished.
        const deps = STAGED.find((a) => a.key === "claude-deps")!;
        if (!ids[deps.key]) {
          const launched = await act<{ terminalId: string }>(page, "agent.launch", {
            agentId: deps.agentId,
            worktreeId: await worktreeIdFor(page, deps.branch),
            location: "grid",
            force: true,
            focusPolicy: "preserve",
          });
          ids[deps.key] = launched.terminalId;
          await expect
            .poll(() => existsSync(path.join(fixture.state, `${deps.key}.pid`)), {
              timeout: T_LONG * 2,
            })
            .toBe(true);
          await page.waitForTimeout(7000);
          let parked = false;
          for (let i = 0; i < 20 && !parked; i++) {
            parked = await page
              .evaluate(
                (id) =>
                  window.electron.fleet
                    .parkRun(id, { note: "Decide after Thursday's infra sync" })
                    .then(() => true)
                    .catch(() => false),
                ids[deps.key]!
              )
              .catch(() => false);
            if (!parked) await page.waitForTimeout(1000);
          }
          if (!parked) throw new Error("could not park the deps run");
        }
        await backToFleet("fiordland", false);
        await act(page, "pilot.toggle");
        const dialog = page.locator('[role="dialog"][aria-label="All agents"]');
        await dialog.waitFor({ state: "visible", timeout: T_LONG });
        await expect
          .poll(() => dialog.getByTestId("pilot-row").count(), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(STAGED.length);
        await settle(page, 1200);
        return (await dialog.getByTestId("pilot-row").count()) >= STAGED.length;
      },
      "review-hub-hokkaido": async () => {
        await enterTheme("hokkaido", false);
        await act(page, "fleet.scope.exit").catch(() => {});
        await act(page, "terminal.disarmAll").catch(() => {});
        const worktreeId = await worktreeIdFor(page, "feature/settlement-export");
        await act(page, "worktree.select", { worktreeId });
        await settle(page, 800);
        const content = page.locator('[data-testid="review-hub-content"]');
        const hubInGrid = page.locator(
          `${SEL.panel.gridPanel}:has([data-testid="review-hub-content"])`
        );
        if ((await hubInGrid.count()) === 0) {
          await act(page, "worktree.openReviewHub", { worktreeId });
          await page
            .locator(SEL.reviewHub.container)
            .waitFor({ state: "visible", timeout: 15_000 });
          await settle(page, 800);
          await page
            .locator(`${SEL.reviewHub.container} [data-testid="panel-dialog-open-as-panel"]`)
            .first()
            .click();
          await hubInGrid.first().waitFor({ state: "visible", timeout: T_LONG });
        }
        await content.first().waitFor({ state: "visible", timeout: T_LONG });
        await settle(page, 1200);
        const message = hubInGrid.locator(SEL.reviewHub.commitMessageInput).first();
        await message.fill(
          "feat(export): stream settlement CSV grouped by merchant\n\nAdds net_minor and a /v1/settlements/export.csv route."
        );
        if ((await page.locator(SEL.panel.gridPanel).count()) < 3) {
          await hubInGrid
            .locator(SEL.reviewHub.fileDiffButton("src/export/settlement.ts"))
            .first()
            .click();
          const dialog = page.locator('[data-testid="panel-dialog"]').last();
          await dialog.waitFor({ state: "visible", timeout: T_LONG });
          await settle(page, 600);
          await dialog.locator('[data-testid="panel-dialog-open-as-panel"]').first().click();
          await expect
            .poll(() => page.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG })
            .toBeGreaterThanOrEqual(3);
        }
        // Two of three files marked viewed, so the still shows review in progress.
        for (const file of ["src/api/routes/settlements.ts", "test/export/settlement.test.ts"]) {
          const toggle = hubInGrid.locator(`[aria-label="Mark ${file} as viewed"]`).first();
          if (await toggle.isVisible().catch(() => false)) await toggle.click().catch(() => {});
        }
        const diffPanel = page
          .locator(SEL.panel.gridPanel)
          .filter({ hasNot: page.locator('[data-testid="review-hub-content"]') })
          .filter({ hasText: "settlement.ts" })
          .first();
        // Dock the agent so the hub and its diff share the grid side by side.
        const claudePane = page.locator(`[data-panel-id="${ids.claude}"]`);
        if (await claudePane.isVisible().catch(() => false)) {
          await claudePane
            .locator(SEL.panel.minimize)
            .first()
            .click()
            .catch(() => {});
        }
        await settle(page, 1500);
        return (
          (await hubInGrid.count()) === 1 &&
          (await diffPanel.isVisible().catch(() => false)) &&
          (await message.inputValue()).length > 0
        );
      },
      "worktree-overview-arashiyama": async () => {
        await backToFleet("arashiyama", false);
        await act(page, "worktree.overview.open");
        const modal = page.locator(SEL.worktree.overviewModal);
        await modal.waitFor({ state: "visible", timeout: T_LONG });
        await expect
          .poll(() => modal.locator("[data-worktree-overview-cell]").count(), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(WORKTREES.length);
        await settle(page, 1500);
        return (await modal.locator("[data-worktree-overview-cell]").count()) >= WORKTREES.length;
      },
    };

    for (const slug of FEATURES) {
      try {
        await escape();
        const ok = await featureSteps[slug]();
        await shoot(slug);
        if (!ok) failures.set(slug, "surface not reached");
        console.log(`[readme] ${slug} ${ok ? "ok" : "SURFACE MISSING"} (${themeOf(slug)})`);
      } catch (error) {
        failures.set(slug, String(error).slice(0, 300));
        console.warn(`[readme] ${slug} failed:`, String(error).slice(0, 300));
      }
      await escape();
    }
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    fixture.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const present: string[] = [];
  const missing: string[] = [];
  for (const slug of expected) {
    const file = path.join(OUT, `${slug}.png`);
    (existsSync(file) && statSync(file).size > 50_000 ? present : missing).push(slug);
  }
  writeFileSync(
    path.join(OUT, "manifest.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        window: WINDOW,
        scale: SCALE,
        themes: THEME_IDS,
        agents: STAGED.map((a) => ({ agent: a.agentId, branch: a.branch, expect: a.expect })),
        expected: expected.length,
        present,
        missing,
        observedStates: observed,
        failures: Object.fromEntries(failures),
      },
      null,
      2
    ) + "\n"
  );
  if (missing.length > 0 || failures.size > 0) {
    throw new Error(
      `[readme] ${present.length}/${expected.length} captured; missing: ${missing.join(", ") || "none"}; ` +
        `failures: ${[...failures].map(([k, v]) => `${k}: ${v}`).join(" | ") || "none"}`
    );
  }
  console.log(`[readme] verified ${present.length}/${expected.length} captures in ${OUT}`);
});
