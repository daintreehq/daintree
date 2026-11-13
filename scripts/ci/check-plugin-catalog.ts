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
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as defaultSleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import * as semver from "semver";

import { computeArchiveHash, verifyPluginArchive } from "../../electron/services/PluginArchive.js";
import {
  parsePluginCatalog,
  type PluginCatalogEntry,
} from "../../electron/services/plugin/pluginCatalogSchema.js";
import { MAX_DNTR_BYTES } from "../../electron/utils/pluginArchiveConstants.js";
import { PLUGIN_CATALOG_MAX_BYTES } from "../../shared/config/pluginCatalog.js";
import type { PluginManifest } from "../../shared/types/plugin.js";

export const CATALOG_FILE = "plugins/catalog.json";
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DownloadOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<unknown>;
}

export interface CheckOptions extends DownloadOptions {
  /** Where the downloads' temporary directory is made. */
  readonly tmpRoot?: string;
}

export interface ReviewNote {
  readonly entry: string;
  readonly reason: string;
}

export interface CatalogCheckResult {
  /** Every entry added or changed, whether or not it passed. */
  readonly checked: readonly string[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
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
 * time, a capability or repository other than its newest earlier listing's,
 * and an already-listed release whose listing changed. Earlier means the base
 * catalog, never another entry in the same change. Repository names compare
 * without case, as GitHub does.
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
    const newest = earlier.reduce((a, b) =>
      semver.compareBuild(b.version, a.version) > 0 ? b : a
    );
    if (newest.repo.toLowerCase() !== entry.repo.toLowerCase()) {
      notes.push({
        entry: key,
        reason: `repository changed from ${newest.repo} (${newest.version}) to ${entry.repo}`,
      });
    }
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

class TransientDownloadError extends Error {}
class OversizeError extends Error {}

/** Fails the stream once more than `limit` bytes have passed through it. */
function byteLimit(limit: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > limit) callback(new OversizeError(`asset exceeds the ${limit} byte limit`));
      else callback(null, chunk);
    },
  });
}

async function downloadOnce(
  url: string,
  destination: string,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<void> {
  // One deadline for the headers and the body together.
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal, redirect: "follow" });
  } catch (err) {
    throw new TransientDownloadError(err instanceof Error ? err.message : String(err));
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    const message = `download failed with HTTP ${response.status}`;
    throw response.status === 429 || response.status >= 500
      ? new TransientDownloadError(message)
      : new Error(message);
  }
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_DNTR_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new Error(`asset is ${declared} bytes, over the ${MAX_DNTR_BYTES} byte limit`);
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
      byteLimit(MAX_DNTR_BYTES),
      createWriteStream(destination),
      { signal }
    );
  } catch (err) {
    if (err instanceof OversizeError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new TransientDownloadError(signal.aborted ? `timed out: ${message}` : message);
  }
}

/**
 * Download `url` to `destination`, refusing a body over `MAX_DNTR_BYTES`, the
 * cap the installer applies. Redirects to GitHub's asset host are followed, and
 * a network failure, a timeout, HTTP 429 or a 5xx is retried with backoff.
 */
export async function downloadArchive(
  url: string,
  destination: string,
  {
    fetch: fetchImpl = fetch,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    attempts = DOWNLOAD_ATTEMPTS,
    sleep = defaultSleep,
  }: DownloadOptions = {}
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadOnce(url, destination, fetchImpl, timeoutMs);
      return;
    } catch (err) {
      if (!(err instanceof TransientDownloadError) || attempt >= attempts) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

/** Download one entry's asset and hold it to the listing. Returns its problems. */
export async function checkEntry(
  entry: PluginCatalogEntry,
  workDir: string,
  download: DownloadOptions = {}
): Promise<string[]> {
  const key = entryKey(entry);
  const archivePath = path.join(workDir, `${entry.sha256}.dntr`);
  try {
    try {
      await downloadArchive(entry.url, archivePath, download);
    } catch (err) {
      return [`${key}: ${entry.url}: ${err instanceof Error ? err.message : String(err)}`];
    }
    // Bytes nobody reviewed say nothing about the listing, so stop here.
    const digest = await computeArchiveHash(archivePath);
    if (digest !== entry.sha256) {
      return [`${key}: the asset's SHA-256 is ${digest}, not the listed ${entry.sha256}`];
    }
    const verified = await verifyPluginArchive(archivePath);
    if (!verified.valid) {
      return [`${key}: the asset isn't an installable .dntr: ${verified.error}`];
    }
    return manifestMismatches(key, entry, verified.manifest);
  } finally {
    await rm(archivePath, { force: true });
  }
}

function manifestMismatches(
  key: string,
  entry: PluginCatalogEntry,
  manifest: PluginManifest
): string[] {
  const errors: string[] = [];
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
  { tmpRoot = os.tmpdir(), ...download }: CheckOptions = {}
): Promise<CatalogCheckResult> {
  const parsedHead = parsePluginCatalog(head);
  if (!parsedHead.ok) {
    return { checked: [], errors: [parsedHead.error], warnings: [], needsPerson: [] };
  }
  const parsedBase = base === undefined ? null : parsePluginCatalog(base);
  const baseEntries = parsedBase?.ok ? parsedBase.catalog.entries : [];
  const warnings =
    parsedBase && !parsedBase.ok
      ? [`the base catalog doesn't parse, so every entry is checked: ${parsedBase.error}`]
      : [];
  const changed = changedEntries(baseEntries, parsedHead.catalog.entries);

  const workDir = await mkdtemp(path.join(tmpRoot, "plugin-catalog-check-"));
  const errors: string[] = [];
  try {
    for (const entry of changed) {
      errors.push(...(await checkEntry(entry, workDir, download)));
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  return {
    checked: changed.map(entryKey),
    errors,
    warnings,
    needsPerson: entriesNeedingPerson(baseEntries, changed),
  };
}

/**
 * The catalog at `ref`, or `undefined` when that commit has no catalog. A
 * catalog that isn't JSON comes back as its text, which `checkCatalog` treats
 * like any other base that doesn't parse, so a pull request can repair it.
 */
function readCatalogAt(ref: string, file: string): unknown {
  let raw: string;
  try {
    raw = execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // The default 1 MiB would refuse a catalog the client still reads.
      maxBuffer: PLUGIN_CATALOG_MAX_BYTES * 4,
    });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (/does not exist|exists on disk, but not in/.test(stderr)) return undefined;
    throw new Error(`git show ${ref}:${file} failed: ${stderr.trim() || String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

/** GitHub workflow commands end at a newline and decode `%` escapes. */
export const escapeAnnotation = (text: string): string =>
  text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export const escapeMarkdown = (text: string): string =>
  text.replace(/\r?\n/g, " ").replace(/[\\`*_[\]<>|]/g, (char) => `\\${char}`);

function writeSummary(result: CatalogCheckResult): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  const list = (items: readonly string[]) => items.map((item) => `- ${escapeMarkdown(item)}`);
  const lines = ["## Plugin catalog", ""];
  if (result.checked.length === 0) lines.push("No entry was added or changed.");
  else lines.push("### Added or changed", "", ...list(result.checked));
  if (result.needsPerson.length > 0) {
    lines.push("", "### Waits for a person", "");
    lines.push(...list(result.needsPerson.map((note) => `${note.entry}: ${note.reason}`)));
  }
  if (result.warnings.length > 0) lines.push("", "### Warnings", "", ...list(result.warnings));
  if (result.errors.length > 0) lines.push("", "### Failed", "", ...list(result.errors));
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
    const text = escapeAnnotation(`${note.entry} waits for a person: ${note.reason}`);
    console.log(`::notice file=${file}::${text}`);
  }
  for (const warning of result.warnings) {
    console.log(`::warning file=${file}::${escapeAnnotation(warning)}`);
  }
  for (const error of result.errors) {
    console.error(`::error file=${file}::${escapeAnnotation(error)}`);
  }
  writeSummary(result);
  if (result.errors.length > 0) return 1;
  console.log(`[catalog] ${file} passed, ${result.checked.length} added or changed`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`::error::${escapeAnnotation(err instanceof Error ? err.message : String(err))}`);
    return 1;
  });
}
