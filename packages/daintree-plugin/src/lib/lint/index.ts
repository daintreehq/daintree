import fs from "node:fs/promises";
import path from "node:path";
import { globby } from "globby";
import { STOCK_COLOUR, splitModifier, splitToken } from "./classTokens.js";
import { extractClassContexts, extractElements } from "./extract.js";
import { CONSISTENCY_RULES } from "./rules/consistency.js";
import { PERF_RULES } from "./rules/perf.js";
import { prepareRaw, prepareScript, prepareStyle } from "./source.js";
import { classesThatCompileToNothing } from "./styleReport.js";
import type { LintFile, LintFileKind, LintFileRole, LintFinding, LintRule } from "./types.js";

export type {
  LintFile,
  LintFileKind,
  LintFileRole,
  LintFinding,
  LintRule,
  LintSeverity,
} from "./types.js";

export const LINT_RULES: readonly LintRule[] = [...PERF_RULES, ...CONSISTENCY_RULES];

export const STYLE_REPORT_RULE_ID = "class-compiles-to-nothing";

export interface LintOptions {
  /** Plugin directory (default: cwd). */
  dir?: string;
  /** Compile the view's classes against the design contract (default: true). */
  styleReport?: boolean;
  /** Override the rule set; tests use it to exercise one rule. */
  rules?: readonly LintRule[];
}

export interface LintResult {
  dir: string;
  /** Linted files, relative to `dir`. */
  files: string[];
  findings: LintFinding[];
  errorCount: number;
  warningCount: number;
  /** Things the author should know that are not findings: skipped files, a missing manifest. */
  notes: string[];
}

const SOURCE_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,css}";

/** Build output, tests and tooling config: none of it is the plugin's own runtime source. */
const IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/__tests__/**",
  "**/__preview__/**",
  "**/__bench__/**",
  "**/__mocks__/**",
  "**/__fixtures__/**",
  "**/*.{test,spec}.*",
  "**/*.d.{ts,mts,cts}",
  "**/*.config.*",
];

const BUILD_CONFIG = /^(?:vite|tsup|rollup|webpack|esbuild|rolldown)\.config\.[cm]?[jt]s$/;

/** Larger than this is a bundle, not something an author edits. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

const VIEW_SEGMENTS = new Set([
  "renderer",
  "view",
  "views",
  "panel",
  "panels",
  "components",
  "ui",
  "hooks",
  "client",
  "web",
  "browser",
]);
const WORKER_SEGMENTS = new Set(["main", "worker", "workers", "server", "node", "backend"]);

interface Manifest {
  main?: unknown;
  contributes?: {
    views?: Array<{ componentPath?: unknown } | null>;
    experimental_views?: Array<{ componentPath?: unknown } | null>;
  };
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "plugin.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

async function hasBuildStep(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  if (entries.some((name) => BUILD_CONFIG.test(name))) return true;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return typeof pkg.scripts?.build === "string";
  } catch {
    return false;
  }
}

const toPosix = (p: string) => p.split(path.sep).join("/");

function isRelativeEntry(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value);
}

function classify(rel: string, code: string, declared: LintFileKind | undefined): LintFileKind {
  if (rel.endsWith(".css")) return "style";
  if (declared) return declared;
  if (
    /["'](?:react(?:\/jsx-runtime)?|react-dom(?:\/client)?|@daintreehq\/plugin-ui)["']/.test(code)
  ) {
    return "view";
  }
  if (/\bexport\s+(?:async\s+)?function\s+activate\b/.test(code)) return "worker";
  const segments = rel.toLowerCase().split("/").slice(0, -1);
  if (segments.some((segment) => VIEW_SEGMENTS.has(segment))) return "view";
  if (segments.some((segment) => WORKER_SEGMENTS.has(segment))) return "worker";
  if (/\.[jt]sx$/.test(rel)) return "view";
  return "shared";
}

interface Candidate {
  rel: string;
  role: LintFileRole;
  declared?: LintFileKind;
}

/**
 * The plugin's own source (globbed, build output excluded) plus what the
 * manifest names. With a build step, the manifest's view entries and their
 * chunks are build output, read only by the rules about bundles; without one,
 * they are the hand-written source.
 */
async function discover(dir: string, manifest: Manifest | null): Promise<Candidate[]> {
  const found = new Map<string, Candidate>();
  for (const rel of await globby(SOURCE_GLOB, { cwd: dir, ignore: IGNORE, dot: false })) {
    found.set(rel, { rel, role: "source" });
  }

  const buildStep = await hasBuildStep(dir);
  const main = isRelativeEntry(manifest?.main) ? path.posix.normalize(manifest.main) : null;
  const contributes = manifest?.contributes;
  // `experimental_views` is the host's deprecated alias, still loaded.
  const views = [...(contributes?.views ?? []), ...(contributes?.experimental_views ?? [])]
    .map((view) => view?.componentPath)
    .filter(isRelativeEntry)
    .map((entry) => path.posix.normalize(entry));

  const inside = (rel: string) => !rel.startsWith("../") && rel !== "..";
  const exists = async (rel: string) =>
    fs
      .stat(path.join(dir, rel))
      .then((s) => s.isFile())
      .catch(() => false);

  if (main && inside(main) && (await exists(main))) {
    // With a build step the entry is output wherever it lives, never source.
    if (buildStep) found.delete(main);
    else found.set(main, { rel: main, role: "source", declared: "worker" });
  }

  for (const view of views) {
    if (!inside(view) || !(await exists(view))) continue;
    const role: LintFileRole = buildStep ? "build" : "source";
    found.set(view, { rel: view, role, declared: "view" });
    const entryDir = path.posix.dirname(view);
    if (entryDir === ".") continue;
    // Chunks the entry imports live beside it; a bundled React is usually in one.
    for (const rel of await globby(`${entryDir}/**/*.{js,mjs}`, {
      cwd: dir,
      ignore: ["**/node_modules/**"],
    })) {
      if (rel === main) continue;
      if (buildStep) found.set(rel, { rel, role, declared: "view" });
      else if (!found.has(rel)) found.set(rel, { rel, role });
    }
  }

  return [...found.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

function appliesTo(rule: LintRule, file: LintFile): boolean {
  const target = rule.target ?? "script";
  if (target === "build") return file.role === "build";
  if (file.role === "build") return false;
  if (target === "style") return file.kind === "style";
  if (file.kind === "style") return false;
  return rule.appliesTo === "any" || rule.appliesTo === file.kind;
}

/** Run every rule over a plugin directory. Never throws for a malformed plugin. */
export async function lintPlugin(opts: LintOptions = {}): Promise<LintResult> {
  const dir = path.resolve(opts.dir ?? process.cwd());
  const rules = opts.rules ?? LINT_RULES;
  const notes: string[] = [];
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`${dir} is not a directory`);
  const manifest = await readManifest(dir);
  if (!manifest) {
    notes.push("No readable plugin.json; files were classified by path and content alone.");
  }

  const files: LintFile[] = [];
  for (const candidate of await discover(dir, manifest)) {
    const absolute = path.join(dir, candidate.rel);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absolute);
    } catch {
      continue;
    }
    // Bytes on disk, not UTF-16 code units: non-ASCII source is larger than its length.
    if (candidate.role === "source" && bytes.byteLength > MAX_SOURCE_BYTES) {
      notes.push(
        `Skipped ${candidate.rel}: larger than 2 MB, so read as a bundle rather than source.`
      );
      continue;
    }
    const raw = bytes.toString("utf8");
    const extension = path.extname(candidate.rel);
    const prepared =
      candidate.role === "build"
        ? prepareRaw(raw)
        : extension === ".css"
          ? prepareStyle(raw)
          : prepareScript(raw, extension);
    if (prepared.parseError) {
      notes.push(`Couldn't parse ${candidate.rel} (${prepared.parseError}); scanned its raw text.`);
    }
    const script = candidate.role === "source" && extension !== ".css";
    files.push({
      ...prepared,
      path: absolute,
      rel: toPosix(candidate.rel),
      kind: classify(candidate.rel, prepared.code, candidate.declared),
      role: candidate.role,
      raw,
      classContexts: script ? extractClassContexts(prepared) : [],
      elements: script ? extractElements(prepared) : [],
    });
  }

  const findings: LintFinding[] = [];
  const seen = new Set<string>();
  const report = (finding: LintFinding) => {
    const key = `${finding.ruleId}\0${finding.file}\0${finding.line}\0${finding.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const file of files) {
    for (const rule of rules) {
      if (!appliesTo(rule, file)) continue;
      for (const hit of rule.check(file)) {
        report({
          ruleId: rule.id,
          severity: rule.severity,
          file: file.rel,
          line: hit.line ?? file.lineAt(hit.offset ?? 0),
          message: hit.message ?? rule.message,
          hint: rule.hint,
        });
      }
    }
  }

  if (opts.styleReport !== false) {
    await styleReport(files, report, notes);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    dir,
    files: files.map((file) => file.rel),
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "warn").length,
    notes,
  };
}

/**
 * One finding per file listing the classes that generate no CSS against the
 * design contract. Stock colours are left to `stock-palette-colour`, which
 * names the fix, so the same class is never reported twice.
 */
async function styleReport(
  files: LintFile[],
  report: (finding: LintFinding) => void,
  notes: string[]
): Promise<void> {
  // A class the plugin styles in its own stylesheet works without Tailwind.
  const ownClasses = new Set<string>();
  for (const file of files) {
    if (file.kind !== "style") continue;
    for (const match of file.code.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) ownClasses.add(match[1]!);
  }
  const perFile = new Map<LintFile, Array<{ token: string; offset: number }>>();
  for (const file of files) {
    if (file.kind !== "view" && file.kind !== "shared") continue;
    const tokens = file.classContexts
      .flat()
      .filter(({ token }) => !STOCK_COLOUR.test(splitModifier(splitToken(token).base).value));
    if (tokens.length > 0) perFile.set(file, tokens);
  }
  if (perFile.size === 0) return;

  let dead: Set<string>;
  try {
    dead = await classesThatCompileToNothing([...perFile.values()].flat().map((t) => t.token));
  } catch (err) {
    notes.push(
      `Style report skipped: couldn't load the design contract (${(err as Error).message}).`
    );
    return;
  }

  for (const [file, tokens] of perFile) {
    const hits = tokens.filter(({ token }) => dead.has(token) && !ownClasses.has(token));
    if (hits.length === 0) continue;
    const names = [...new Set(hits.map((hit) => hit.token))];
    report({
      ruleId: STYLE_REPORT_RULE_ID,
      severity: "warn",
      file: file.rel,
      line: file.lineAt(hits[0]!.offset),
      message: `classes that compile to nothing (Tailwind generates no CSS for them): ${names.join(", ")}`,
      hint: "check each against the design-contract tokens in docs/plugins/views.md — typos and classes from another Tailwind version generate no CSS",
    });
  }
}
