#!/usr/bin/env node
// Renders the README artwork. Each piece is an HTML page in art/ drawn in
// daintree.org's own tokens and type, fed the real agent and theme data from
// export-data.ts and, for the pieces that show the app, the real-app captures
// from e2e/screenshots/readme-showcase.spec.ts. Chromium screenshots each one
// at 2x so it stays sharp at GitHub's README width on a retina screen.
//
//   node scripts/readme/render-art.mjs --out /abs/dir --shots /abs/app-shots
//   node scripts/readme/render-art.mjs --out /abs/dir --shots /abs/app-shots --only themes,hero
//
// A page names its outputs in <meta name="variants"> (one file per colour
// scheme it is drawn for) and its encoding in <meta name="format">. Output
// never goes into the repo; publish.mjs uploads it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const ART_DIR = path.join(HERE, "art");

function parseArgs(argv) {
  const args = { out: "", shots: "", only: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else if (argv[i] === "--shots") args.shots = path.resolve(argv[++i]);
    else if (argv[i] === "--only") args.only = argv[++i].split(",").filter(Boolean);
  }
  if (!args.out) throw new Error("--out <dir> is required");
  return args;
}

function exportData(outDir) {
  const file = path.join(outDir, "readme-data.json");
  execFileSync(
    "npx",
    ["tsx", "--tsconfig", "tsconfig.json", path.join(HERE, "export-data.ts"), file],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "inherit"],
    }
  );
  return JSON.parse(readFileSync(file, "utf8"));
}

/** File URLs for everything a page may draw: app captures by name, theme artwork by id. */
function assetUrls(shotsDir, data) {
  const shots = {};
  if (shotsDir && existsSync(shotsDir)) {
    for (const f of readdirSync(shotsDir).filter((n) => n.endsWith(".png"))) {
      shots[f.replace(/\.png$/, "")] = pathToFileURL(path.join(shotsDir, f)).href;
    }
  }
  const themeArt = {};
  for (const theme of data.themes) {
    const file = path.join(REPO_ROOT, "public", theme.heroImage.replace(/^\//, ""));
    if (!existsSync(file)) throw new Error(`theme ${theme.id} has no artwork at ${file}`);
    themeArt[theme.id] = pathToFileURL(file).href;
  }
  return { shots, themeArt };
}

async function renderPage(browser, page, art, outDir) {
  const html = readFileSync(path.join(ART_DIR, page), "utf8");
  const meta = (name, fallback) =>
    html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]+)"`))?.[1]?.trim() ?? fallback;
  // "@shots" means one output per app capture, framed the same way.
  const declared = meta("variants", "dark");
  // A page may also name captures that get a tighter phone crop, as
  // "<capture>--narrow" variants.
  const narrow = meta("narrow", "")
    .split(/\s+/)
    .filter((n) => n && art.shots[n]);
  const variants =
    declared === "@shots"
      ? [...Object.keys(art.shots).sort(), ...narrow.map((n) => `${n}--narrow`)]
      : declared.split(/\s+/);
  if (!variants.length) throw new Error(`${page}: no app captures to frame (pass --shots)`);
  const format = meta("format", "png");
  const base = page.replace(/\.html$/, "");
  const written = [];

  for (const scheme of variants) {
    const tab = await browser.newPage({
      viewport: { width: 1200, height: 800 },
      deviceScaleFactor: 2,
    });
    await tab.addInitScript(
      (payload) => {
        window.__ART__ = payload;
      },
      { ...art, scheme }
    );
    const errors = [];
    // A page that throws never reports ready; fail on the throw, not the timeout.
    const thrown = new Promise((_, reject) =>
      tab.on("pageerror", (error) => {
        errors.push(String(error));
        reject(new Error(`${page} (${scheme}): ${error}`));
      })
    );
    thrown.catch(() => {});
    await tab.goto(pathToFileURL(path.join(ART_DIR, page)).href, { waitUntil: "networkidle" });
    await Promise.race([
      tab.waitForFunction(() => window.__artReady === true, null, { timeout: 30_000 }),
      thrown,
    ]);
    await tab.evaluate(async () => {
      await Promise.all([
        document.fonts.load('500 16px "DM Sans"'),
        document.fonts.load('500 16px "IBM Plex Mono"'),
      ]);
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
    });
    const problems = await tab.evaluate(() => {
      const out = [];
      for (const family of ["DM Sans", "IBM Plex Mono"]) {
        if (!document.fonts.check(`500 16px "${family}"`)) out.push(`font ${family} not loaded`);
      }
      for (const img of document.images)
        if (!img.naturalWidth) out.push(`image failed: ${img.src}`);
      return out;
    });
    if (errors.length || problems.length) {
      throw new Error(`${page} (${scheme}): ${[...errors, ...problems].join("; ")}`);
    }

    const name = variants.length > 1 || declared === "@shots" ? `${base}-${scheme}` : base;
    const png = path.join(outDir, `${name}.png`);
    await tab.locator("#art").screenshot({ path: png, omitBackground: true });
    await tab.close();

    if (format === "png") {
      written.push(png);
    } else {
      const webp = path.join(outDir, `${name}.webp`);
      const quality =
        format === "webp-lossless" ? ["-lossless", "-z", "9"] : ["-q", "90", "-m", "6"];
      execFileSync("cwebp", [...quality, "-quiet", png, "-o", webp]);
      rmSync(png);
      written.push(webp);
    }
  }
  return written;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const data = exportData(args.out);
  const art = { data, ...assetUrls(args.shots, data) };
  const pages = readdirSync(ART_DIR)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => !args.only.length || args.only.includes(f.replace(/\.html$/, "")));
  if (!pages.length) throw new Error("no art pages selected");

  const browser = await chromium.launch();
  const written = [];
  try {
    for (const page of pages) written.push(...(await renderPage(browser, page, art, args.out)));
  } finally {
    await browser.close();
  }
  const missing = written.filter((f) => !existsSync(f));
  if (missing.length) throw new Error(`art missing on disk: ${missing.join(", ")}`);
  for (const f of written) console.log(`  ${path.basename(f)}`);
  console.log(`README_ART wrote=${written.length} dir=${args.out}`);
}

await main();
