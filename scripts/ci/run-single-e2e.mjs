#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALID_PROJECTS = new Set([
  "core",
  "full-terminal",
  "full-worktree",
  "full-presets",
  "full-platform",
  "full-panels",
  "full-resilience",
  "full-plugins",
  "online",
  "nightly",
]);
const MAX_WORKERS = 8;
const MAX_RETRIES = 5;

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function normalizeSpecPath(raw) {
  const value = String(raw ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

  if (path.isAbsolute(value)) fail("E2E_TEST_FILE must be relative to the repository root");
  if (value.split("/").includes("..")) fail("E2E_TEST_FILE must not contain '..'");
  if (!value.startsWith("e2e/")) fail("E2E_TEST_FILE must be under e2e/");
  if (!value.endsWith(".spec.ts")) fail("E2E_TEST_FILE must end with .spec.ts");

  const absolute = path.join(repoRoot, value);
  if (!existsSync(absolute)) fail(`E2E test file does not exist: ${value}`);
  if (!statSync(absolute).isFile()) fail(`E2E_TEST_FILE is not a file: ${value}`);

  return value;
}

function normalizeSpecPaths(raw) {
  const values = String(raw ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) fail("E2E_TEST_FILE is required");

  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const specPath = normalizeSpecPath(value);
    if (seen.has(specPath)) continue;
    seen.add(specPath);
    normalized.push(specPath);
  }
  return normalized;
}

function readIntegerEnv(name, { min, max, allowEmpty }) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw && allowEmpty) return null;
  if (!/^\d+$/.test(raw)) fail(`${name} must be an integer`);

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

const project = String(process.env.E2E_SUITE ?? "core").trim();
if (!VALID_PROJECTS.has(project)) {
  fail(`E2E_SUITE must be one of: ${Array.from(VALID_PROJECTS).join(", ")}`);
}

const testFiles = normalizeSpecPaths(process.env.E2E_TEST_FILE);
// `full-<bucket>` projects live in e2e/full/<bucket>/ subdirectories; everything
// else lives in a top-level e2e/<project>/ directory.
const expectedPrefix = project.startsWith("full-")
  ? `e2e/full/${project.slice("full-".length)}/`
  : `e2e/${project}/`;
for (const testFile of testFiles) {
  if (!testFile.startsWith(expectedPrefix)) {
    fail(`Project '${project}' can only run specs under ${expectedPrefix}`);
  }
}

const grep = String(process.env.E2E_GREP ?? "").trim();
const workers = readIntegerEnv("E2E_WORKERS", { min: 1, max: MAX_WORKERS, allowEmpty: false });
const retries = readIntegerEnv("E2E_RETRIES", { min: 0, max: MAX_RETRIES, allowEmpty: true });

const playwrightCli = path.join(repoRoot, "node_modules/playwright/cli.js");
if (!existsSync(playwrightCli)) {
  fail("Playwright CLI is not installed. Run npm ci before invoking this script.");
}

const args = [playwrightCli, "test", `--project=${project}`, ...testFiles, `--workers=${workers}`];
if (retries !== null) args.push(`--retries=${retries}`);
if (grep) args.push("--grep", grep);

const displayArgs = [path.relative(repoRoot, playwrightCli), ...args.slice(1)];
console.log(`Running: node ${displayArgs.map((arg) => JSON.stringify(arg)).join(" ")}`);

if (process.argv.includes("--dry-run") || process.env.E2E_DRY_RUN === "1") {
  process.exit(0);
}

const result = spawnSync(process.execPath, args, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  fail(result.error.message);
}

process.exit(result.status ?? 1);
