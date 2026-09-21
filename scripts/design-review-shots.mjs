#!/usr/bin/env node
// Drives the theme-review capture harness over one theme, several, or all
// fifteen, and reports what actually landed on disk per theme.
//
// This is the entry point for a design review of a theme: it produces the
// contact set (20 states covering the workbench plus every overlay surface
// that carries theme weight) that a reviewer — human or model — then judges
// against real rendered pixels.
//
// Captures default to a temp dir, never the repo. Screenshots are evidence for
// a review, not an artifact of the project, and a capture sweep that writes
// into the working tree shows up as 300 untracked files in the next commit.
//
//   node scripts/design-review-shots.mjs --theme daintree
//   node scripts/design-review-shots.mjs --theme daintree,bondi
//   node scripts/design-review-shots.mjs --all
//   node scripts/design-review-shots.mjs --theme bondi --out /abs/dir --tag round-2
//
// Exits non-zero if any theme failed to produce its full state list. The spec
// itself verifies the files it promised and fails loudly when they are absent,
// so a green run here means the pixels exist — not merely that Playwright
// reached the end of the spec.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ALL_THEMES = [
  "daintree",
  "bondi",
  "table-mountain",
  "arashiyama",
  "fiordland",
  "galapagos",
  "highlands",
  "namib",
  "redwoods",
  "atacama",
  "bali",
  "hokkaido",
  "serengeti",
  "svalbard",
  "movile",
];

function parseArgs(argv) {
  const args = { themes: [], out: null, tag: null, scale: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.themes = [...ALL_THEMES];
    else if (a === "--theme") args.themes.push(...(argv[++i] ?? "").split(",").filter(Boolean));
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--tag") args.tag = argv[++i];
    else if (a === "--scale") args.scale = argv[++i];
    else if (a === "--only") args.only = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.themes.length === 0) {
  console.log(
    [
      "Usage: node scripts/design-review-shots.mjs (--theme <id[,id]> | --all) [options]",
      "",
      "  --theme <ids>  comma-separated theme ids",
      "  --all          every built-in theme (15)",
      "  --out <dir>    output root (default: $TMPDIR/daintree-design-review)",
      "  --tag <s>      suffix on each png, to keep rounds side by side",
      "  --scale <n>    device scale factor (default 2)",
      "  --only <steps> comma-separated step filter",
      "",
      `Themes: ${ALL_THEMES.join(", ")}`,
    ].join("\n")
  );
  process.exit(args.help ? 0 : 2);
}

const unknown = args.themes.filter((t) => !ALL_THEMES.includes(t));
if (unknown.length > 0) {
  console.error(`Unknown theme(s): ${unknown.join(", ")}`);
  console.error(`Known: ${ALL_THEMES.join(", ")}`);
  process.exit(2);
}

const outRoot = path.resolve(args.out ?? path.join(tmpdir(), "daintree-design-review"));
mkdirSync(outRoot, { recursive: true });

// The built app is what the harness drives — a stale bundle silently reviews
// code nobody wrote. Fail early rather than produce confident wrong pixels.
if (!existsSync(path.resolve("dist", "index.html"))) {
  console.error("No build found at dist/index.html. Run `npm run build:e2e` first.");
  process.exit(2);
}

const results = [];

for (const theme of args.themes) {
  const dir = path.join(outRoot, theme);
  mkdirSync(dir, { recursive: true });
  console.log(`\n=== ${theme} → ${dir} ===`);

  const env = {
    ...process.env,
    DAINTREE_SHOT_THEME: theme,
    DAINTREE_SHOT_DIR: dir,
  };
  if (args.tag) env.DAINTREE_SHOT_TAG = args.tag;
  if (args.scale) env.DAINTREE_SCREENSHOT_SCALE = args.scale;
  if (args.only) env.DAINTREE_SHOT_ONLY = args.only;

  const run = spawnSync(
    "npx",
    [
      "playwright",
      "test",
      "--project=screenshots",
      "theme-review",
      "--workers=1",
      "--reporter=list",
    ],
    { env, stdio: "inherit" }
  );

  // Trust the files, not the exit code — count them here as well as in the spec.
  const pngs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")) : [];
  let manifest = null;
  // A filtered run writes manifest.partial.json so it cannot clobber the record
  // of the last full sweep — read whichever one this run produced.
  const manifestPath = path.join(dir, args.only ? "manifest.partial.json" : "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      // A corrupt manifest is itself a failure signal; the png count still rules.
    }
  }

  results.push({
    theme,
    dir,
    status: run.status,
    pngs: pngs.length,
    expected: manifest?.expected ?? null,
    missing: manifest?.missing ?? null,
  });
}

console.log("\n=== summary ===");
let failed = 0;
for (const r of results) {
  const ok = r.status === 0 && r.pngs > 0 && (r.missing === null || r.missing.length === 0);
  if (!ok) failed++;
  const detail =
    r.expected === null
      ? `${r.pngs} png, no manifest`
      : `${r.pngs} png, ${r.expected - (r.missing?.length ?? 0)}/${r.expected} states`;
  console.log(`${ok ? "OK  " : "FAIL"} ${r.theme.padEnd(16)} ${detail}  ${r.dir}`);
  if (r.missing?.length) console.log(`     missing: ${r.missing.join(", ")}`);
}

console.log(`\n${results.length - failed}/${results.length} themes captured → ${outRoot}`);
process.exit(failed > 0 ? 1 : 0);
