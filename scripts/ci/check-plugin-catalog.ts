#!/usr/bin/env -S npx tsx
// Checks the community plugin catalog on a pull request (#16778): the whole
// file must pass the parser Daintree uses on the published catalog, and every
// entry the pull request adds or changes is downloaded and held to its listing.
// The asset's SHA-256 must equal `sha256`, the archive must pass the installer's
// own archive check, and its manifest name, version and capabilities must equal
// the entry's. It also names the entries policy says wait for a person, without
// failing on them: a first listing, a new capability, a changed repository, and
// a release whose listing changed in place.
//
//   npx tsx scripts/ci/check-plugin-catalog.ts [--base <git ref>] [--catalog <path>]
//
// With no --base every entry is downloaded.

import { execFileSync } from "node:child_process";
import { appendFileSync, createWriteStream, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { finished } from "node:stream/promises";

import * as semver from "semver";

import { computeArchiveHash, verifyPluginArchive } from "../../electron/services/PluginArchive.js";
import {
  parsePluginCatalog,
  type PluginCatalogEntry,
} from "../../electron/services/plugin/pluginCatalogSchema.js";
import { MAX_DNTR_BYTES } from "../../electron/utils/pluginArchiveConstants.js";

export const CATALOG_FILE = "plugins/catalog.json";
const DOWNLOAD_TIMEOUT_MS = 120_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReviewNote {
  readonly entry: string;
  readonly reason: string;
}

export interface CatalogCheckResult {
  readonly checked: readonly string[];
  readonly errors: readonly string[];
  readonly needsPerson: readonly ReviewNote[];
}

const entryKey = (entry: Pick<PluginCatalogEntry, "id" | "version">): string =>
  `${entry.id}@${entry.version}`;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const sameEntry = (a: PluginCatalogEntry, b: PluginCatalogEntry): boolean =>
  a.id === b.id &&
  a.repo === b.repo &&
  a.version === b.version &&
  a.url === b.url &&
  a.sha256 === b.sha256 &&
  sameList(a.capabilities, b.capabilities);

/** Entries in `head` that `base` doesn't list, or lists differently. */
export function changedEntries(
  base: readonly PluginCatalogEntry[],
  head: readonly PluginCatalogEntry[]
): PluginCatalogEntry[] {
  const before = new Map(base.map((entry) => [entryKey(entry), entry]));
  return head.filter((entry) => {
    const previous = before.get(entryKey(entry));
    return !previous || !sameEntry(previous, entry);
  });
}

/**
 * What the review policy says a person approves: a plugin listed for the first
 * time, a capability its newest earlier listing didn't declare, a repository
 * its earlier listings didn't name, and an already-listed release whose
 * listing changed. Repository names compare without case, as GitHub does.
 */
export function entriesNeedingPerson(
  base: readonly PluginCatalogEntry[],
  changed: readonly PluginCatalogEntry[]
): ReviewNote[] {
  const notes: ReviewNote[] = [];
  for (const entry of changed) {
    const key = entryKey(entry);
    const earlier = base.filter((listed) => listed.id === entry.id);
    if (earlier.length === 0) {
      notes.push({ entry: key, reason: "first listing" });
      continue;
    }
    if (earlier.some((listed) => listed.version === entry.version)) {
      notes.push({ entry: key, reason: "an already-listed release changed" });
    }
    const repos = new Set(earlier.map((listed) => listed.repo.toLowerCase()));
    if (!repos.has(entry.repo.toLowerCase())) {
      notes.push({ entry: key, reason: `repository changed to ${entry.repo}` });
    }
    const newest = earlier.reduce((a, b) => (semver.gt(b.version, a.version) ? b : a));
    const added = entry.capabilities.filter((cap) => !newest.capabilities.includes(cap));
    if (added.length > 0) {
      notes.push({
        entry: key,
        reason: `new capabilities since ${newest.version}: ${added.join(", ")}`,
      });
    }
  }
  return notes;
}

/**
 * Download `url` to `destination`, refusing a body over `MAX_DNTR_BYTES`, the
 * cap the installer applies. Redirects to GitHub's asset host are followed.
 */
export async function downloadArchive(
  url: string,
  destination: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DNTR_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new Error(`asset is ${declared} bytes, over the ${MAX_DNTR_BYTES} byte limit`);
  }
  const file = createWriteStream(destination);
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_DNTR_BYTES) {
        throw new Error(`asset exceeds the ${MAX_DNTR_BYTES} byte limit`);
      }
      if (!file.write(value)) await new Promise((resolve) => file.once("drain", resolve));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    file.destroy();
    throw err;
  }
  file.end();
  await finished(file);
}

/** Download one entry's asset and hold it to the listing. Returns its problems. */
export async function checkEntry(
  entry: PluginCatalogEntry,
  workDir: string,
  fetchImpl: FetchLike = fetch
): Promise<string[]> {
  const key = entryKey(entry);
  const archivePath = path.join(workDir, `${entry.sha256}.dntr`);
  try {
    await downloadArchive(entry.url, archivePath, fetchImpl);
  } catch (err) {
    return [`${key}: ${entry.url}: ${err instanceof Error ? err.message : String(err)}`];
  }

  const errors: string[] = [];
  const digest = await computeArchiveHash(archivePath);
  if (digest !== entry.sha256) {
    errors.push(`${key}: the asset's SHA-256 is ${digest}, not the listed ${entry.sha256}`);
  }
  const verified = await verifyPluginArchive(archivePath);
  if (!verified.valid) {
    errors.push(`${key}: the asset isn't an installable .dntr: ${verified.error}`);
    return errors;
  }
  const { manifest } = verified;
  if (manifest.name !== entry.id) {
    errors.push(`${key}: the archive's manifest.name is "${manifest.name}", not "${entry.id}"`);
  }
  if (manifest.version !== entry.version) {
    errors.push(
      `${key}: the archive's manifest.version is "${manifest.version}", not "${entry.version}"`
    );
  }
  const declared = manifest.capabilities ?? [];
  if (!sameList(declared, entry.capabilities)) {
    errors.push(
      `${key}: capabilities must be the manifest's list ${JSON.stringify(declared)}, ` +
        `in its order; the entry lists ${JSON.stringify(entry.capabilities)}`
    );
  }
  return errors;
}

/**
 * Check a head catalog against the base it changes. A base that doesn't parse
 * lends no trust: every head entry is downloaded.
 */
export async function checkCatalog(
  head: unknown,
  base: unknown,
  { fetch: fetchImpl = fetch }: { fetch?: FetchLike } = {}
): Promise<CatalogCheckResult> {
  const parsedHead = parsePluginCatalog(head);
  if (!parsedHead.ok) {
    return { checked: [], errors: [parsedHead.error], needsPerson: [] };
  }
  const parsedBase = base === undefined ? null : parsePluginCatalog(base);
  const baseEntries = parsedBase?.ok ? parsedBase.catalog.entries : [];
  const changed = changedEntries(baseEntries, parsedHead.catalog.entries);

  const workDir = await mkdtemp(path.join(os.tmpdir(), "plugin-catalog-"));
  const errors: string[] = [];
  try {
    for (const entry of changed) {
      errors.push(...(await checkEntry(entry, workDir, fetchImpl)));
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  return {
    checked: changed.map(entryKey),
    errors,
    needsPerson: entriesNeedingPerson(baseEntries, changed),
  };
}

/** The catalog at `ref`, or `undefined` when that commit has no catalog. */
function readCatalogAt(ref: string, file: string): unknown {
  let raw: string;
  try {
    raw = execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (/does not exist|exists on disk, but not in/.test(stderr)) return undefined;
    throw new Error(`git show ${ref}:${file} failed: ${stderr.trim() || String(err)}`);
  }
  return JSON.parse(raw);
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function writeSummary(result: CatalogCheckResult): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  const lines = ["## Plugin catalog", ""];
  lines.push(
    result.checked.length === 0
      ? "No entry was added or changed."
      : `Downloaded and checked: ${result.checked.map((key) => `\`${key}\``).join(", ")}`
  );
  if (result.needsPerson.length > 0) {
    lines.push("", "### Waits for a person", "");
    for (const note of result.needsPerson) lines.push(`- \`${note.entry}\`: ${note.reason}`);
  }
  if (result.errors.length > 0) {
    lines.push("", "### Failed", "");
    for (const error of result.errors) lines.push(`- ${error}`);
  }
  appendFileSync(summaryFile, `${lines.join("\n")}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const file = argValue(argv, "--catalog") ?? CATALOG_FILE;
  const baseRef = argValue(argv, "--base");
  const head: unknown = JSON.parse(readFileSync(file, "utf8"));
  const base = baseRef ? readCatalogAt(baseRef, CATALOG_FILE) : undefined;

  const result = await checkCatalog(head, base);
  for (const key of result.checked) console.log(`[catalog] checked ${key}`);
  for (const note of result.needsPerson) {
    console.log(`::notice file=${file}::${note.entry} waits for a person: ${note.reason}`);
  }
  for (const error of result.errors) {
    console.error(`::error file=${file}::${error.replace(/\r?\n/g, "%0A")}`);
  }
  writeSummary(result);
  if (result.errors.length > 0) return 1;
  console.log(`[catalog] ${file} passed (${result.checked.length} entries downloaded)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    return 1;
  });
}
