/**
 * The `app` template: a copy of the maintained reference application,
 * `plugins/sample-project/acme.requests/` in the Daintree repository, with its
 * committed build. Unlike the string templates it ships as real files — the
 * CLI build stages the tree into `dist/reference-app/` — because what makes it
 * useful is the built `dist/`: a project scaffolded with it opens in Daintree
 * before anyone runs `npm install`.
 *
 * The build never spells the plugin's own name (the worker reads
 * `host.pluginInfo.manifestId`, views get `pluginId`), so renaming touches only
 * the manifest, `package.json` and the prose and tests around them; `dist/` is
 * copied byte for byte.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCAFFOLD_TOOLCHAIN_RANGES, type ScaffoldContext } from "./templates.js";

/** The reference's own manifest name, which a scaffold replaces. */
export const REFERENCE_APP_NAME = "acme.requests";
const REFERENCE_MCP_NAME = "requests";

/**
 * What of the reference a scaffold receives: the source, its build, and what
 * an author works with. `node_modules/`, preview output and anything else in
 * the directory stay behind.
 */
const REFERENCE_APP_DIRS = ["src", "dist", "review", "__tests__", "skills", "tours", "icons"];
/**
 * npm never packs a file named `.gitignore`, so the CLI build stages it under
 * this name and a scaffold writes it back. Losing it would lose the rule that
 * keeps `dist/` tracked in a repository that ignores `dist/` at its root.
 */
const STAGED_GITIGNORE = "_gitignore";

const REFERENCE_APP_FILES = [
  STAGED_GITIGNORE,
  "plugin.json",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "playwright.config.ts",
  "README.md",
  "AGENTS.md",
  ".gitignore",
];

/** Text files whose prose and fixtures name the plugin, renamed with it. `dist/` never is. */
const RENAMED_TEXT = /\.(md|ts|tsx|json)$/;

/**
 * Where the reference is: staged beside the bundle in a published CLI, or the
 * repository's own copy when the CLI runs from source (tests, the monorepo).
 */
export async function referenceAppRoot(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "reference-app"),
    path.resolve(here, "../../../../plugins/sample-project", REFERENCE_APP_NAME),
  ];
  for (const candidate of candidates) {
    const found = await fs
      .access(path.join(candidate, "plugin.json"))
      .then(() => true)
      .catch(() => false);
    if (found) return candidate;
  }
  throw new Error(
    `The bundled reference application is missing (looked in ${candidates.join(", ")}); this daintree-plugin install is incomplete`
  );
}

async function walk(root: string, rel: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walk(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

/** The reference's files, keyed by POSIX path relative to its root, sorted. */
export async function listReferenceAppFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const file of REFERENCE_APP_FILES) {
    const present = await fs
      .stat(path.join(root, file))
      .then((stats) => stats.isFile())
      .catch(() => false);
    if (present) files.push(file);
  }
  for (const dir of REFERENCE_APP_DIRS) {
    const present = await fs
      .stat(path.join(root, dir))
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (present) files.push(...(await walk(root, dir)));
  }
  if (
    !files.includes("plugin.json") ||
    !files.some((file) => file.startsWith("dist/")) ||
    !(files.includes(".gitignore") || files.includes(STAGED_GITIGNORE))
  ) {
    throw new Error(
      `The reference application in ${root} is missing plugin.json, dist/ or its .gitignore`
    );
  }
  return files.sort();
}

/**
 * Copy the reference into `to`, for the CLI build. Only what a scaffold
 * receives is staged, so the published package carries nothing else.
 */
export async function stageReferenceApp(from: string, to: string): Promise<void> {
  await fs.rm(to, { recursive: true, force: true });
  for (const rel of await listReferenceAppFiles(from)) {
    const target = path.join(to, rel === ".gitignore" ? STAGED_GITIGNORE : rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(from, rel), target);
  }
}

/**
 * The agent-facing server key is `daintree-<mcpName>`: 1-16 lowercase letters,
 * digits and hyphens. The plugin segment is already that alphabet; cut it to
 * length, and steer clear of the two names the Assistant's own servers hold.
 */
export function referenceMcpName(pluginName: string): string {
  const cut = pluginName.slice(0, 16).replace(/-+$/, "");
  return cut === "docs" || cut === "runbooks" ? `${cut}-app` : cut;
}

function renameStrings(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => renameStrings(item, from, to));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renameStrings(item, from, to)])
    );
  }
  return value;
}

function customizeManifest(text: string, ctx: ScaffoldContext): string {
  // Qualified references (`acme.requests.<id>`) follow the new name; the
  // example's own wording ("Request Desk", its commands) is the author's to change.
  const manifest = renameStrings(
    JSON.parse(text),
    `${REFERENCE_APP_NAME}.`,
    `${ctx.scopedName}.`
  ) as Record<string, unknown>;
  manifest.name = ctx.scopedName;
  manifest.displayName = ctx.displayName;
  manifest.mcpName = referenceMcpName(ctx.pluginName);
  const application = manifest.application as Record<string, unknown> | undefined;
  if (application) application.name = ctx.displayName.slice(0, 64);
  return JSON.stringify(manifest, null, 2) + "\n";
}

function customizePackageJson(text: string, ctx: ScaffoldContext): string {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  pkg.name = ctx.scopedName;
  pkg.description = `${ctx.displayName} — a Daintree project application.`;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  for (const [name, range] of Object.entries(SCAFFOLD_TOOLCHAIN_RANGES)) {
    if (name in devDeps) devDeps[name] = range;
  }
  pkg.devDependencies = devDeps;
  return JSON.stringify(pkg, null, 2) + "\n";
}

/**
 * The reference, renamed for `ctx`, keyed by POSIX path relative to the new
 * plugin's root. Text the rename touches is a string; everything else (the
 * build, icons, any audio) is the reference's bytes.
 */
export async function loadReferenceAppFiles(
  ctx: ScaffoldContext,
  root?: string
): Promise<Record<string, string | Uint8Array>> {
  const from = root ?? (await referenceAppRoot());
  const mcpName = referenceMcpName(ctx.pluginName);
  // One pass over the original text, so a new name that happens to contain
  // the other token (a publisher named `daintree-requests`) is never rewritten.
  const renames: Record<string, string> = {
    [REFERENCE_APP_NAME]: ctx.scopedName,
    [`daintree-${REFERENCE_MCP_NAME}`]: `daintree-${mcpName}`,
  };
  const pattern = new RegExp(
    Object.keys(renames)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g"
  );
  const out: Record<string, string | Uint8Array> = {};
  for (const rel of await listReferenceAppFiles(from)) {
    const bytes = await fs.readFile(path.join(from, rel));
    if (rel === STAGED_GITIGNORE) {
      out[".gitignore"] = new Uint8Array(bytes);
    } else if (rel === "plugin.json") {
      out[rel] = customizeManifest(bytes.toString("utf8"), ctx);
    } else if (rel === "package.json") {
      out[rel] = customizePackageJson(bytes.toString("utf8"), ctx);
    } else if (!rel.startsWith("dist/") && RENAMED_TEXT.test(rel)) {
      out[rel] = bytes.toString("utf8").replace(pattern, (token) => renames[token]!);
    } else {
      out[rel] = new Uint8Array(bytes);
    }
  }
  return out;
}
