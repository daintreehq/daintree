#!/usr/bin/env node
// Renders README.md the way github.com shows it, so README work can be judged
// on pixels: GitHub's own Markdown API does the sanitising, GitHub's Markdown
// CSS does the styling, and Chromium screenshots it in light and dark mode at
// desktop and phone widths.
//
//   node scripts/readme/preview.mjs --out /abs/dir
//   node scripts/readme/preview.mjs --out /abs/dir --assets /abs/art-dir
//
// --assets swaps every https://cdn.daintree.org/readme/.../<file> image for
// <art-dir>/<file>, so artwork can be reviewed before it is published.
// Needs an authenticated `gh` (the Markdown API is rate-limited without one).
// Captures go wherever --out points; never into the repo.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CDN_PREFIX = "https://cdn.daintree.org/readme/";
const CSS_URL = (scheme) =>
  `https://cdn.jsdelivr.net/npm/github-markdown-css@5.8.1/github-markdown-${scheme}.css`;

const PAGE = {
  light: { bg: "#ffffff", border: "#d1d9e0", fg: "#1f2328", muted: "#59636e" },
  dark: { bg: "#0d1117", border: "#3d444d", fg: "#f0f6fc", muted: "#9198a1" },
};
// The README box on a repo page is ~896px wide on a desktop browser; phones get
// the full viewport less the page gutter.
const VIEWPORTS = {
  desktop: { width: 1012, box: 896 },
  mobile: { width: 414, box: 398 },
};
const SLICE_HEIGHT = 1400;

function parseArgs(argv) {
  const args = { out: "", assets: "", readme: path.join(REPO_ROOT, "README.md") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else if (argv[i] === "--assets") args.assets = path.resolve(argv[++i]);
    else if (argv[i] === "--readme") args.readme = path.resolve(argv[++i]);
  }
  if (!args.out) throw new Error("--out <dir> is required");
  return args;
}

function renderMarkdown(text) {
  return execFileSync(
    "gh",
    [
      "api",
      "-X",
      "POST",
      "markdown",
      "-f",
      "mode=gfm",
      "-f",
      "context=daintreehq/daintree",
      "-F",
      "text=@-",
    ],
    { input: text, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
}

/** GitHub proxies images through camo; point them back at the source, or at local art. */
function resolveImages(html, assetsDir) {
  return html.replace(
    /(src|srcset)="https:\/\/camo\.githubusercontent\.com\/[^"]+"([^>]*?)data-canonical-src="([^"]+)"/g,
    (_m, attr, between, canonical) => {
      let url = canonical;
      if (assetsDir && canonical.startsWith(CDN_PREFIX)) {
        const local = path.join(assetsDir, path.basename(canonical.split("?")[0]));
        if (!existsSync(local)) throw new Error(`--assets has no ${path.basename(local)}`);
        url = pathToFileURL(local).href;
      }
      return `${attr}="${url}"${between}data-canonical-src="${canonical}"`;
    }
  );
}

function pageHtml(body, scheme, viewport) {
  const c = PAGE[scheme];
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${CSS_URL(scheme)}">
<style>
  html, body { margin: 0; background: ${c.bg}; }
  .frame { width: ${viewport.box}px; margin: 24px auto 48px; border: 1px solid ${c.border}; border-radius: 6px; }
  .bar { padding: 8px 16px; border-bottom: 1px solid ${c.border}; font: 600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: ${c.fg}; }
  .markdown-body { padding: ${viewport.width < 600 ? 16 : 32}px; background: ${c.bg}; }
</style></head>
<body><div class="frame"><div class="bar">README</div><article class="markdown-body">${body}</article></div></body></html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const html = resolveImages(renderMarkdown(readFileSync(args.readme, "utf8")), args.assets);

  const browser = await chromium.launch();
  const written = [];
  try {
    for (const scheme of ["dark", "light"]) {
      for (const [name, viewport] of Object.entries(VIEWPORTS)) {
        const page = await browser.newPage({
          viewport: { width: viewport.width, height: 900 },
          colorScheme: scheme,
          deviceScaleFactor: 2,
        });
        const file = path.join(args.out, `.page-${scheme}-${name}.html`);
        writeFileSync(file, pageHtml(html, scheme, viewport));
        await page.goto(pathToFileURL(file).href, { waitUntil: "networkidle" });
        await page.evaluate(() =>
          Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)))
        );
        const broken = await page.evaluate(() =>
          [...document.images]
            .filter((img) => !img.naturalWidth)
            .map((img) => img.currentSrc || img.src)
        );
        if (broken.length)
          throw new Error(`images failed to load (${scheme}/${name}): ${broken.join(", ")}`);

        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        const full = path.join(args.out, `readme-${scheme}-${name}.png`);
        await page.screenshot({ path: full, fullPage: true });
        written.push(full);
        // Reviewers read slices: a full-length capture is too tall to judge at size.
        for (let y = 0, i = 1; y < height; y += SLICE_HEIGHT, i++) {
          const slice = path.join(
            args.out,
            `readme-${scheme}-${name}-${String(i).padStart(2, "0")}.png`
          );
          await page.screenshot({
            path: slice,
            clip: { x: 0, y, width: viewport.width, height: Math.min(SLICE_HEIGHT, height - y) },
            fullPage: true,
          });
          written.push(slice);
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  const onDisk = readdirSync(args.out).filter((f) => f.endsWith(".png"));
  const missing = written.filter((f) => !onDisk.includes(path.basename(f)));
  if (missing.length) throw new Error(`captures missing on disk: ${missing.join(", ")}`);
  console.log(`README_PREVIEW wrote=${written.length} dir=${args.out}`);
}

await main();
