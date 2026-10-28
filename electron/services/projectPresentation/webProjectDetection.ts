import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { readCapped } from "./repoSuggestion.js";

/**
 * Whether a project's files look like a web project (#14069): the dev
 * preview's default in that project, never a gate on it. The user's own level,
 * a preview already in use and the app-wide "always show" all beat it.
 *
 * Read-only and bounded, since it runs every time a view reads its profile: a
 * fixed set of files at the root, and one level into the folders a workspace
 * or a front end lives in, never a walk. Links are never followed, nothing is
 * executed and nothing is written. When nothing matches the answer is no, the
 * way Vercel's and Netlify's detectors report no framework rather than guess:
 * a project this misses is one Features setting away from the preview.
 */

const MAX_MANIFEST_BYTES = 256 * 1024;
/** Workspace packages looked into, across every folder named. */
const MAX_PACKAGE_DIRS = 32;
/** Workspace patterns read, from all three manifests together. */
const MAX_WORKSPACE_PATTERNS = 16;
/** Entries read from one workspace folder before the rest are left unread. */
const MAX_DIR_ENTRIES = 256;

/**
 * A dependency that only an app serving pages carries. A bare `vite` is not
 * one: libraries build with it and Vitest pulls it in, so Vite counts only
 * with a page to serve or a script that serves it.
 */
const WEB_PACKAGES = new Set([
  "next",
  "nuxt",
  "@sveltejs/kit",
  "astro",
  "@remix-run/dev",
  "@react-router/dev",
  "react-scripts",
  "gatsby",
  "@angular-devkit/build-angular",
  "@angular/build",
  "@vue/cli-service",
  "@solidjs/start",
  "@builder.io/qwik-city",
  "@redwoodjs/core",
  "@11ty/eleventy",
  "@docusaurus/core",
  "vitepress",
  "vuepress",
  "webpack-dev-server",
  "parcel",
  "http-server",
  "live-server",
]);

/** Scripts that start whatever the project develops against. */
const DEV_SCRIPT_NAMES = ["dev", "start", "serve", "develop"];

/** A dev script that serves pages, whatever its dependencies say. */
const DEV_SERVER_COMMANDS: readonly RegExp[] = [
  // `vite`, `vite dev`, `vite --host`; not `vite build`, `vitest`, `vite-node` or `electron-vite`.
  /(?<![\w-])vite(?![\w.-])(?!\s+build\b)/,
  /\bnext\s+(?:dev|start)\b/,
  /\bnux[it]\s+dev\b/,
  /\bastro\s+dev\b/,
  /\bremix\s+(?:vite:)?dev\b/,
  /\breact-router\s+dev\b/,
  /\breact-scripts\s+start\b/,
  /\bng\s+serve\b/,
  /\bvue-cli-service\s+serve\b/,
  /\bgatsby\s+develop\b/,
  /\bwebpack(?:-dev-server\b|\s+serve\b)/,
  /\bparcel\b(?!\s+build\b)/,
  /\b(?:http-server|live-server|browser-sync)\b/,
  /\beleventy\b.*--serve\b/,
  /\bpython3?\s+-m\s+http\.server\b/,
];

const WEB_GEMS = /^\s*gem\s+["'](?:rails|jekyll|github-pages|middleman|bridgetown|hanami)["']/m;
const WEB_COMPOSER_PACKAGES = [
  "laravel/framework",
  "symfony/framework-bundle",
  "cakephp/cakephp",
  "yiisoft/yii2",
];
const HUGO_CONFIGS = ["hugo.toml", "hugo.yaml", "hugo.yml", "hugo.json"];
/** Hugo's older config name, and Zola's: a site only when it names the URL it is served at. */
const SITE_CONFIGS = ["config.toml", "config.yaml", "config.yml", "config.json"];
const SITE_BASE_URL = /^\s*["']?base_?url["']?\s*[:=]/im;
const SITE_BASE_URL_KEY = /^base_?url$/i;
const SITE_CONTENT_DIRS = ["content", "layouts", "themes", "templates"];
const JEKYLL_DIRS = ["_layouts", "_posts", "_includes"];
const ELEVENTY_CONFIGS = [
  ".eleventy.js",
  "eleventy.config.js",
  "eleventy.config.cjs",
  "eleventy.config.mjs",
  "eleventy.config.ts",
];

/** Where a front end usually sits beside a backend, workspace or not. */
const FRONTEND_DIRS = ["frontend", "web", "client", "site", "www"];
/** Where a workspace that names no packages of its own keeps them (Turborepo, Nx). */
const DEFAULT_WORKSPACE_DIRS = ["apps", "packages"];

type PackageJson = Record<string, unknown>;

/**
 * `true` or `false` for a folder that could be read, `null` for one that could
 * not — a missing root, one that is not a directory, or one this process may
 * not look inside — so the caller keeps its default rather than reading
 * "unknown" as "not a web project".
 */
export async function detectWebProject(
  projectRoot: string | null | undefined
): Promise<boolean | null> {
  if (!projectRoot) return null;
  try {
    if (!(await fs.stat(projectRoot)).isDirectory()) return null;
    await fs.access(projectRoot, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return null;
  }
  const pkg = await readPackageJson(projectRoot);
  if (pkg !== null && (await isWebPackage(projectRoot, pkg))) return true;
  if (await hasRootWebSignal(projectRoot)) return true;
  for (const dir of await packageDirs(projectRoot, pkg)) {
    const child = await readPackageJson(dir);
    if (child !== null && (await isWebPackage(dir, child))) return true;
  }
  return false;
}

async function isWebPackage(dir: string, pkg: PackageJson): Promise<boolean> {
  const deps = { ...asRecord(pkg.dependencies), ...asRecord(pkg.devDependencies) };
  if (Object.keys(deps).some((name) => WEB_PACKAGES.has(name))) return true;
  const scripts = asRecord(pkg.scripts);
  for (const name of DEV_SCRIPT_NAMES) {
    const body = scripts[name];
    if (typeof body === "string" && DEV_SERVER_COMMANDS.some((re) => re.test(body))) return true;
  }
  return Object.hasOwn(deps, "vite") && (await isFile(path.join(dir, "index.html")));
}

async function hasRootWebSignal(root: string): Promise<boolean> {
  const at = (...segments: string[]) => path.join(root, ...segments);
  // A page at the root is a site, served by whatever serves it.
  if (await isFile(at("index.html"))) return true;

  const gemfile = await readText(at("Gemfile"));
  if (gemfile !== null && WEB_GEMS.test(gemfile)) return true;

  const managePy = await readText(at("manage.py"));
  if (managePy !== null && /\bdjango\b/i.test(managePy)) return true;

  if (await isFile(at("artisan"))) return true;
  const composer = parseJson(await readText(at("composer.json")));
  if (composer !== null) {
    const required = { ...asRecord(composer.require), ...asRecord(composer["require-dev"]) };
    if (WEB_COMPOSER_PACKAGES.some((name) => Object.hasOwn(required, name))) return true;
  }

  const mix = await readText(at("mix.exs"));
  if (mix !== null && /:phoenix\b/.test(mix)) return true;

  if (await anyFile(root, HUGO_CONFIGS)) return true;
  if (await anyFile(root, ELEVENTY_CONFIGS)) return true;
  if ((await isFile(at("_config.yml"))) && (await anyDirectory(root, JEKYLL_DIRS))) return true;
  for (const name of SITE_CONFIGS) {
    const config = await readText(at(name));
    if (config !== null && namesSiteUrl(name, config)) {
      return anyDirectory(root, SITE_CONTENT_DIRS);
    }
  }
  return false;
}

/** The config names the URL the site is served at, as Hugo's and Zola's do. */
function namesSiteUrl(name: string, text: string): boolean {
  if (!name.endsWith(".json")) return SITE_BASE_URL.test(text);
  const config = parseJson(text);
  return config !== null && Object.keys(config).some((key) => SITE_BASE_URL_KEY.test(key));
}

/**
 * The folders a web app could sit in below the root: the usual front-end
 * folders, and a workspace's packages one level down. Only plain relative
 * paths a workspace names are followed — no `**`, no negation, nothing that
 * leaves the root — and never through a link.
 */
async function packageDirs(root: string, pkg: PackageJson | null): Promise<string[]> {
  const patterns = [
    ...workspacePatterns(pkg?.workspaces),
    ...workspacePatterns(parseYaml(await readText(path.join(root, "pnpm-workspace.yaml")))),
    ...workspacePatterns(parseJson(await readText(path.join(root, "lerna.json")))),
  ].slice(0, MAX_WORKSPACE_PATTERNS);
  const containers = new Set<string>();
  const literals = new Set<string>(FRONTEND_DIRS);
  if (
    patterns.length === 0 &&
    ((await isFile(path.join(root, "turbo.json"))) || (await isFile(path.join(root, "nx.json"))))
  ) {
    for (const dir of DEFAULT_WORKSPACE_DIRS) containers.add(dir);
  }
  for (const pattern of patterns) {
    const relative = pattern.replace(/^\.\//, "").replace(/\/$/, "");
    if (relative.endsWith("/*")) {
      const container = relative.slice(0, -2);
      if (isPlainRelativePath(container)) containers.add(container);
    } else if (isPlainRelativePath(relative)) {
      literals.add(relative);
    }
  }

  const dirs: string[] = [];
  for (const literal of literals) {
    if (dirs.length >= MAX_PACKAGE_DIRS) return dirs;
    if (await isPlainDirectory(root, literal)) dirs.push(path.join(root, literal));
  }
  for (const container of containers) {
    if (dirs.length >= MAX_PACKAGE_DIRS) return dirs;
    if (!(await isPlainDirectory(root, container))) continue;
    const names = await childDirectoryNames(path.join(root, container));
    for (const name of names) {
      if (dirs.length >= MAX_PACKAGE_DIRS) return dirs;
      const dir = path.join(root, container, name);
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * The real directories in `dir`, sorted, from at most `MAX_DIR_ENTRIES` of
 * its entries: a folder holding thousands is read no further than that.
 */
async function childDirectoryNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    const handle = await fs.opendir(dir);
    let read = 0;
    try {
      for await (const entry of handle) {
        if (++read > MAX_DIR_ENTRIES) break;
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          names.push(entry.name);
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return [];
  }
  return names.sort();
}

/** `["apps/*", …]` from `package.json` `workspaces`, `pnpm-workspace.yaml` or `lerna.json`. */
function workspacePatterns(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : asRecord(raw).packages;
  return Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isPlainRelativePath(relative: string): boolean {
  const segments = relative.split("/");
  return (
    segments.length <= 2 &&
    segments.every((segment) => segment !== "." && segment !== ".." && /^[\w.@-]+$/.test(segment))
  );
}

/** Every step from the root is a real directory, so a link can't lead the read outside it. */
async function isPlainDirectory(root: string, relative: string): Promise<boolean> {
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if (!(await isDirectory(current))) return false;
  }
  return true;
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  return parseJson(await readText(path.join(dir, "package.json")));
}

/** The file's text when it is a plain file within the cap, else `null`. */
async function readText(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    const bytes = await readCapped(filePath, stat, MAX_MANIFEST_BYTES);
    if (bytes === null) return null;
    const text = bytes.toString("utf-8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

function parseJson(text: string | null): PackageJson | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as PackageJson)
      : null;
  } catch {
    return null;
  }
}

function parseYaml(text: string | null): unknown {
  if (text === null) return null;
  try {
    return loadYaml(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await fs.lstat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function anyFile(root: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if (await isFile(path.join(root, name))) return true;
  }
  return false;
}

async function anyDirectory(root: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if (await isDirectory(path.join(root, name))) return true;
  }
  return false;
}
