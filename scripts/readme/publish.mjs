#!/usr/bin/env node
// Publishes the README artwork to cdn.daintree.org: every
// https://cdn.daintree.org/readme/... image README.md references, taken from
// the render-art.mjs output directory by file name.
//
//   node scripts/readme/publish.mjs --art /abs/art-dir            # upload
//   node scripts/readme/publish.mjs --art /abs/art-dir --dry-run  # list only
//
// Publish once, never replace: GitHub's image proxy caches these URLs, so a key
// that already holds different bytes stops the run. Changed artwork goes out
// under a new version folder (readme/v2/...) with README.md updated to match.
// Needs wrangler signed in (CLOUDFLARE_API_TOKEN, plus CLOUDFLARE_ACCOUNT_ID if
// the token spans accounts).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUCKET = "daintree-assets";
const ORIGIN = "https://cdn.daintree.org/";
const TYPES = { ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml" };

function parseArgs(argv) {
  const args = { art: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--art") args.art = path.resolve(argv[++i]);
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  if (!args.art) throw new Error("--art <dir> is required");
  return args;
}

function referencedUrls() {
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  return [...new Set(readme.match(/https:\/\/cdn\.daintree\.org\/readme\/[^"'\s)]+/g) ?? [])];
}

async function publish(url, file, dryRun) {
  const key = url.slice(ORIGIN.length);
  const type = TYPES[path.extname(file)];
  if (!type) throw new Error(`no content type for ${file}`);
  // Probe with HEAD: a GET that misses gets its 404 cached at the edge, and the
  // freshly uploaded object then stays hidden behind it for a while.
  const current = await fetch(url, { method: "HEAD" });
  if (current.ok) {
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    if (!bytes.equals(readFileSync(file))) {
      throw new Error(
        `${url} already holds different bytes; publish changed art under a new version folder.`
      );
    }
    console.log(`  already published ${url}`);
    return;
  }
  if (current.status !== 404)
    throw new Error(`could not check ${url} before uploading (${current.status})`);
  if (dryRun) {
    console.log(`  would upload ${url}`);
    return;
  }
  execFileSync(
    "wrangler",
    [
      "r2",
      "object",
      "put",
      `${BUCKET}/${key}`,
      "--file",
      file,
      "--content-type",
      type,
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--remote",
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  console.log(`  uploaded ${url}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const urls = referencedUrls();
  if (!urls.length) throw new Error("README.md references no cdn.daintree.org/readme/ images");
  const missing = urls.filter((url) => !existsSync(path.join(args.art, path.basename(url))));
  if (missing.length)
    throw new Error(`not in ${args.art}: ${missing.map((u) => path.basename(u)).join(", ")}`);
  for (const url of urls) await publish(url, path.join(args.art, path.basename(url)), args.dryRun);
  console.log(`README_PUBLISH ${urls.length} files${args.dryRun ? " (dry run)" : ""}`);
}

await main();
