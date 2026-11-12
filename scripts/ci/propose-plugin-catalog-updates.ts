#!/usr/bin/env -S npx tsx
// Opens a catalog pull request for each new release of a listed plugin
// (#16780). For every repository the catalog names, it reads the newest GitHub
// releases, downloads each `.dntr` asset that could be new, and proposes an
// entry built from those bytes: their SHA-256, and the id, version and
// capabilities of the manifest inside. Each pull request says whether the
// repository and capabilities match the plugin's previous entry. A person
// merges every one of them; plugins/README.md says why.
//
//   npx tsx scripts/ci/propose-plugin-catalog-updates.ts [--dry-run] [--catalog <path>]
//
// Pull requests are opened with PLUGIN_CATALOG_BOT_TOKEN, since one opened with
// the workflow's own token starts no checks. Without it the run is a dry run: it
// reads GitHub (with GITHUB_TOKEN when set) and downloads assets, but opens
// nothing. --catalog, for dry runs only, reads that file instead of the
// committed catalog.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as semver from "semver";

import { computeArchiveHash, verifyPluginArchive } from "../../electron/services/PluginArchive.js";
import {
  parsePluginCatalog,
  type PluginCatalogEntry,
} from "../../electron/services/plugin/pluginCatalogSchema.js";
import { PLUGIN_CATALOG_MAX_BYTES } from "../../shared/config/pluginCatalog.js";
import {
  CATALOG_FILE,
  changedEntries,
  downloadArchive,
  entriesNeedingPerson,
  escapeAnnotation,
  escapeMarkdown,
  type DownloadOptions,
} from "./check-plugin-catalog.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GITHUB_API = "https://api.github.com";
const API_TIMEOUT_MS = 30_000;
const DEFAULT_REPOSITORY = "daintreehq/daintree";
export const DEFAULT_BASE_BRANCH = "develop";
/**
 * GitHub lists releases newest first, and only a release above the newest
 * listed one is proposed, so the first page covers anything published since
 * the last run.
 */
const RELEASES_PER_REPOSITORY = 30;
const OPEN_PULL_REQUEST_PAGES = 10;
export const BRANCH_PREFIX = "plugin-catalog/";
export const LABELS = {
  catalog: "plugin-catalog",
  quickMerge: "catalog: quick merge",
  needsPerson: "catalog: needs a person",
} as const;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

export interface Release {
  readonly tag_name: string;
  readonly html_url: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly ReleaseAsset[];
}

export interface PullRequestRef {
  readonly number: number;
  readonly html_url: string;
  readonly state: string;
  readonly merged_at?: string | null;
}

export interface OpenPullRequestRequest {
  readonly branch: string;
  readonly base: string;
  /** The commit the branch starts from, the one the catalog was read at. */
  readonly baseSha: string;
  readonly path: string;
  /** The catalog's blob at `baseSha`, which the commit replaces. */
  readonly blobSha: string;
  readonly content: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface OpenedPullRequest extends PullRequestRef {
  /** Set when the pull request opened but its labels couldn't be added. */
  readonly labelError?: string;
}

/** The GitHub calls the bot makes, so tests can stand in for GitHub. */
export interface CatalogGitHub {
  listReleases(owner: string, name: string): Promise<readonly Release[]>;
  /** Every pull request, in any state, whose head is `branch` in this repository. */
  pullRequestsFor(branch: string): Promise<readonly PullRequestRef[]>;
  /** The open pull requests into `base`, from any author or fork. */
  openPullRequests(base: string): Promise<readonly PullRequestRef[]>;
  /** The catalog's text at `ref`, or `undefined` when it has none. */
  catalogAt(ref: string): Promise<string | undefined>;
  openPullRequest(request: OpenPullRequestRequest): Promise<OpenedPullRequest>;
}

export interface WatchedRepository {
  readonly owner: string;
  readonly name: string;
  /** The plugins that have an entry naming this repository. */
  readonly ids: ReadonlySet<string>;
}

export interface Proposal {
  readonly entry: PluginCatalogEntry;
  readonly previous: PluginCatalogEntry;
  /** Why a person approves it; empty means a quick merge. */
  readonly needsPerson: readonly string[];
  readonly release: Release;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  /** Absent on a dry run. */
  readonly pullRequest?: OpenedPullRequest;
}

export interface SkippedRelease {
  readonly what: string;
  readonly reason: string;
}

export interface ProposeResult {
  readonly proposed: readonly Proposal[];
  readonly skipped: readonly SkippedRelease[];
  /** Problems the plugin's author fixes: an unreachable repository, a bad asset. */
  readonly warnings: readonly string[];
  /** Problems the bot couldn't get past: the run fails. */
  readonly errors: readonly string[];
}

export interface ProposeOptions {
  /** The catalog's text at `baseCommit`. */
  readonly catalogText: string;
  readonly github: CatalogGitHub;
  /** The branch pull requests go into. */
  readonly baseBranch?: string;
  /** Where each pull request's branch starts. Required unless `dryRun`. */
  readonly baseCommit?: { readonly sha: string; readonly blobSha: string };
  readonly dryRun?: boolean;
  readonly download?: DownloadOptions;
  readonly tmpRoot?: string;
  readonly format?: (text: string) => Promise<string>;
}

const entryKey = (entry: Pick<PluginCatalogEntry, "id" | "version">): string =>
  `${entry.id}@${entry.version}`;

/** Build metadata is dropped: it can't make a release newer, and it can spell an invalid ref. */
export const branchName = (entry: Pick<PluginCatalogEntry, "id" | "version">): string =>
  `${BRANCH_PREFIX}${entry.id}-${semver.parse(entry.version)?.version ?? entry.version}`;

/** The spelling the catalog requires: `semver.parse` also takes a leading "v". */
export function isCanonicalSemver(value: string): boolean {
  const parsed = semver.parse(value);
  if (!parsed) return false;
  const build = parsed.build.length > 0 ? `+${parsed.build.join(".")}` : "";
  return value === `${parsed.version}${build}`;
}

/** `https://github.com/{owner}/{repo}` from any URL under that repository. */
export function repoOfUrl(url: string): string {
  const [owner = "", name = ""] = new URL(url).pathname.split("/").slice(1);
  return `https://github.com/${owner}/${name}`;
}

/** Each plugin's newest entry by semver, the one a new release is compared with. */
export function newestEntries(
  entries: readonly PluginCatalogEntry[]
): Map<string, PluginCatalogEntry> {
  const newest = new Map<string, PluginCatalogEntry>();
  for (const entry of entries) {
    const current = newest.get(entry.id);
    if (!current || semver.compareBuild(entry.version, current.version) > 0) {
      newest.set(entry.id, entry);
    }
  }
  return newest;
}

/**
 * Every repository an entry names, each with the plugins listed from it. A
 * repository proposes releases only of those plugins, so listing one plugin
 * never lets its repository propose another. Names compare without case, as
 * GitHub does.
 */
export function watchedRepositories(entries: readonly PluginCatalogEntry[]): WatchedRepository[] {
  const byRepo = new Map<string, { owner: string; name: string; ids: Set<string> }>();
  for (const entry of entries) {
    const [owner, name] = new URL(entry.repo).pathname.split("/").slice(1);
    const key = `${owner}/${name}`.toLowerCase();
    let repo = byRepo.get(key);
    if (!repo) {
      repo = { owner, name, ids: new Set() };
      byRepo.set(key, repo);
    }
    repo.ids.add(entry.id);
  }
  return [...byRepo.values()];
}

/**
 * Whether an asset's file name, as `daintree-plugin package` writes it
 * (`{id}-{version}.dntr`), says it can't be proposed: a version no newer than
 * the plugin's newest entry, or a prerelease. Only ever used to skip a
 * download; for anything else the manifest decides.
 */
export function cannotBeNew(
  asset: ReleaseAsset,
  watched: WatchedRepository,
  newest: ReadonlyMap<string, PluginCatalogEntry>
): boolean {
  for (const id of watched.ids) {
    const listed = newest.get(id);
    const prefix = `${id}-`;
    if (!listed || !asset.name.startsWith(prefix)) continue;
    const version = asset.name.slice(prefix.length, -".dntr".length);
    if (!isCanonicalSemver(version)) continue;
    return semver.prerelease(version) !== null || !semver.gt(version, listed.version);
  }
  return false;
}

export async function formatCatalog(text: string): Promise<string> {
  const prettier = await import("prettier");
  const filepath = path.join(repoRoot, CATALOG_FILE);
  const config = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(text, { ...config, filepath });
}

/**
 * The catalog with `entry` added after the plugin's last entry in the file, so
 * pull requests for different plugins touch different lines. Everything else
 * in the file is kept as it is.
 */
export async function catalogWithEntry(
  text: string,
  entry: PluginCatalogEntry,
  format: (text: string) => Promise<string> = formatCatalog
): Promise<string> {
  const raw = JSON.parse(text) as { entries: unknown[] } & Record<string, unknown>;
  const entries = [...raw.entries];
  let at = entries.length;
  for (let index = entries.length - 1; index >= 0; index--) {
    if ((entries[index] as { id?: unknown }).id === entry.id) {
      at = index + 1;
      break;
    }
  }
  entries.splice(at, 0, {
    id: entry.id,
    repo: entry.repo,
    version: entry.version,
    url: entry.url,
    sha256: entry.sha256,
    capabilities: [...entry.capabilities],
  });
  return format(`${JSON.stringify({ ...raw, entries }, null, 2)}\n`);
}

/**
 * Why `content` isn't exactly the base catalog plus `entry`, or `undefined`
 * when it is: it must pass the app's parser, stay under the size the app
 * reads, and differ from the base by that one entry and nothing else.
 */
export function rewriteProblem(
  base: readonly PluginCatalogEntry[],
  content: string,
  entry: PluginCatalogEntry
): string | undefined {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > PLUGIN_CATALOG_MAX_BYTES) {
    return `the catalog would be ${bytes} bytes, over the ${PLUGIN_CATALOG_MAX_BYTES} byte limit`;
  }
  const parsed = parsePluginCatalog(JSON.parse(content));
  if (!parsed.ok) return `its entry would make the catalog invalid: ${parsed.error}`;
  const changed = changedEntries(base, parsed.catalog.entries);
  if (
    parsed.catalog.entries.length !== base.length + 1 ||
    changed.length !== 1 ||
    entryKey(changed[0]) !== entryKey(entry)
  ) {
    return "rewriting the catalog changed more than the one entry";
  }
  return undefined;
}

const code = (text: string): string => `\`${text.replace(/[`\r\n|\\]/g, "")}\``;
const capabilityList = (capabilities: readonly string[]): string =>
  capabilities.length === 0 ? "none" : capabilities.map(code).join(", ");

/** The pull request's title, body and labels. */
export function describeProposal(
  entry: PluginCatalogEntry,
  previous: PluginCatalogEntry,
  needsPerson: readonly string[],
  release: Release
): { title: string; body: string; labels: string[] } {
  const title = `chore(catalog): add ${entry.id} ${entry.version}`;
  const added = entry.capabilities.filter((cap) => !previous.capabilities.includes(cap));
  const removed = previous.capabilities.filter((cap) => !entry.capabilities.includes(cap));
  const sameRepo = previous.repo.toLowerCase() === entry.repo.toLowerCase();
  const lines = [
    `Adds ${code(entry.id)} ${code(entry.version)} to the plugin catalog, from the release ${code(release.tag_name)}: ${entry.url}`,
    "",
  ];
  if (needsPerson.length === 0) {
    lines.push(
      `**Quick merge.** The repository and capabilities match ${code(previous.version)}, the plugin's previous entry.`
    );
  } else {
    lines.push("**Needs a person.** This release differs from the plugin's previous entry:", "");
    lines.push(...needsPerson.map((reason) => `- ${escapeMarkdown(reason)}`));
  }
  lines.push(
    "",
    `| | ${code(previous.version)} (listed) | ${code(entry.version)} (this release) |`,
    "| --- | --- | --- |",
    `| Repository | ${previous.repo} | ${entry.repo}${sameRepo ? "" : " (changed)"} |`,
    `| Capabilities | ${capabilityList(previous.capabilities)} | ${capabilityList(entry.capabilities)} |`,
    `| SHA-256 | ${code(previous.sha256)} | ${code(entry.sha256)} |`
  );
  if (removed.length > 0) {
    lines.push("", `Capabilities no longer declared: ${capabilityList(removed)}.`);
  }
  if (added.length === 0 && removed.length === 0 && entry.capabilities.join() !== previous.capabilities.join()) {
    lines.push("", "The same capabilities, in a different order.");
  }
  lines.push(
    "",
    "The SHA-256 is of the asset as downloaded, and the archive passed the installer's own check; the id, version and capabilities come from its manifest. The `plugin-catalog` check downloads it again.",
    "",
    "A person merges this either way: a quick merge means the release matches what was reviewed before, not that anyone has looked at it. Review confirms the source and the bytes, never that the code is safe."
  );
  const labels = [LABELS.catalog, needsPerson.length === 0 ? LABELS.quickMerge : LABELS.needsPerson];
  return { title, body: `${lines.join("\n")}\n`, labels };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface InspectedAsset {
  readonly sha256: string;
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
}

/** Download one asset and read what it is. A string is why it can't be listed. */
async function inspectAsset(
  asset: ReleaseAsset,
  archivePath: string,
  download: DownloadOptions
): Promise<InspectedAsset | string> {
  try {
    await downloadArchive(asset.browser_download_url, archivePath, download);
    const sha256 = await computeArchiveHash(archivePath);
    const verified = await verifyPluginArchive(archivePath);
    if (!verified.valid) return `it isn't an installable .dntr: ${verified.error}`;
    const { name, version, capabilities } = verified.manifest;
    return { sha256, id: name, version, capabilities: capabilities ?? [] };
  } catch (err) {
    return errorText(err);
  } finally {
    await rm(archivePath, { force: true });
  }
}

interface Candidate {
  readonly entry: PluginCatalogEntry;
  readonly release: Release;
  readonly what: string;
}

/**
 * Find every release of a watched repository above its plugin's newest entry
 * and open a pull request for each one nothing has proposed yet. A bot pull
 * request for the release in any state counts: closed unmerged, a person
 * declined it; merged, it was listed and perhaps later delisted. Neither is
 * proposed again. So does an open pull request from anyone that adds it.
 */
export async function proposeCatalogUpdates({
  catalogText,
  github,
  baseBranch = DEFAULT_BASE_BRANCH,
  baseCommit,
  dryRun = false,
  download = {},
  tmpRoot = os.tmpdir(),
  format = formatCatalog,
}: ProposeOptions): Promise<ProposeResult> {
  const proposed: Proposal[] = [];
  const skipped: SkippedRelease[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const result = () => ({ proposed, skipped, warnings, errors });

  if (!dryRun && !baseCommit) throw new Error("a base commit is needed to open pull requests");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(catalogText);
  } catch (err) {
    errors.push(`${CATALOG_FILE} isn't JSON: ${errorText(err)}`);
    return result();
  }
  const parsed = parsePluginCatalog(parsedJson);
  if (!parsed.ok) {
    errors.push(`${CATALOG_FILE} doesn't parse, so nothing is proposed: ${parsed.error}`);
    return result();
  }
  const entries = parsed.catalog.entries;
  const newest = newestEntries(entries);
  const listedUrls = new Set(entries.map((entry) => entry.url));

  const candidates: Candidate[] = [];
  const workDir = await mkdtemp(path.join(tmpRoot, "plugin-catalog-propose-"));
  try {
    let downloads = 0;
    for (const watched of watchedRepositories(entries)) {
      const repoName = `${watched.owner}/${watched.name}`;
      let releases: readonly Release[];
      try {
        releases = await github.listReleases(watched.owner, watched.name);
      } catch (err) {
        warnings.push(`${repoName}: its releases couldn't be read: ${errorText(err)}`);
        continue;
      }
      for (const release of releases) {
        if (release.draft || release.prerelease) continue;
        // After a rename or transfer GitHub answers for the old name and links
        // the new one, which is the repository a new entry names.
        const releaseRepo = repoOfUrl(release.html_url);
        for (const asset of release.assets) {
          if (!asset.name.endsWith(".dntr")) continue;
          if (listedUrls.has(asset.browser_download_url)) continue;
          if (cannotBeNew(asset, watched, newest)) continue;
          const what = `${repoName} ${release.tag_name} ${asset.name}`;
          if (repoOfUrl(asset.browser_download_url).toLowerCase() !== releaseRepo.toLowerCase()) {
            warnings.push(`${what}: the asset isn't under its release's repository ${releaseRepo}`);
            continue;
          }
          const archivePath = path.join(workDir, `${downloads++}.dntr`);
          const inspected = await inspectAsset(asset, archivePath, download);
          if (typeof inspected === "string") {
            warnings.push(`${what}: ${inspected}`);
            continue;
          }
          if (!watched.ids.has(inspected.id)) {
            skipped.push({
              what,
              reason: newest.has(inspected.id)
                ? `${inspected.id} isn't listed from ${repoName}`
                : `${inspected.id} isn't listed; a first listing is its author's pull request`,
            });
            continue;
          }
          if (!isCanonicalSemver(inspected.version)) {
            warnings.push(`${what}: its manifest version "${inspected.version}" isn't canonical semver`);
            continue;
          }
          if (semver.prerelease(inspected.version)) {
            skipped.push({ what, reason: `${inspected.version} is a prerelease` });
            continue;
          }
          const previous = newest.get(inspected.id)!;
          if (!semver.gt(inspected.version, previous.version)) {
            skipped.push({
              what,
              reason: `${inspected.version} isn't newer than the listed ${previous.version}`,
            });
            continue;
          }
          candidates.push({
            entry: {
              id: inspected.id,
              repo: releaseRepo,
              version: inspected.version,
              url: asset.browser_download_url,
              sha256: inspected.sha256,
              capabilities: inspected.capabilities,
            },
            release,
            what,
          });
        }
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  // Two different assets claiming one release leave no way to tell which is
  // the real one, so neither is proposed.
  const byKey = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = entryKey(candidate.entry);
    byKey.set(key, [...(byKey.get(key) ?? []), candidate]);
  }

  let openProposals: Promise<Map<string, PullRequestRef>> | undefined;
  const readOpenProposals = async (): Promise<Map<string, PullRequestRef>> => {
    const index = new Map<string, PullRequestRef>();
    for (const pr of await github.openPullRequests(baseBranch)) {
      const text = await github.catalogAt(`refs/pull/${pr.number}/head`);
      if (text === undefined) continue;
      let head: unknown;
      try {
        head = JSON.parse(text);
      } catch {
        continue;
      }
      const headCatalog = parsePluginCatalog(head);
      if (!headCatalog.ok) continue;
      for (const added of changedEntries(entries, headCatalog.catalog.entries)) {
        if (!index.has(entryKey(added))) index.set(entryKey(added), pr);
      }
    }
    return index;
  };

  for (const [key, group] of byKey) {
    const distinct = new Map(group.map((c) => [`${c.entry.url} ${c.entry.sha256}`, c]));
    if (distinct.size > 1) {
      const urls = [...distinct.values()].map((c) => c.entry.url).join(", ");
      warnings.push(`${key}: ${distinct.size} different assets claim it (${urls}), so none is proposed`);
      continue;
    }
    const { entry, release, what } = group[0];

    let content: string;
    try {
      content = await catalogWithEntry(catalogText, entry, format);
    } catch (err) {
      errors.push(`${key}: the catalog couldn't be rewritten: ${errorText(err)}`);
      continue;
    }
    const problem = rewriteProblem(entries, content, entry);
    if (problem) {
      warnings.push(`${what}: ${problem}`);
      continue;
    }

    const branch = branchName(entry);
    let existing: PullRequestRef | undefined;
    try {
      existing = (await github.pullRequestsFor(branch))[0];
      existing ??= (await (openProposals ??= readOpenProposals())).get(key);
    } catch (err) {
      errors.push(`${key}: pull requests couldn't be read, so none is opened: ${errorText(err)}`);
      continue;
    }
    if (existing) {
      const state = existing.merged_at ? "merged" : existing.state;
      skipped.push({ what, reason: `pull request #${existing.number} (${state}) already proposed ${key}` });
      continue;
    }

    const previous = newest.get(entry.id)!;
    const needsPerson = entriesNeedingPerson(entries, [entry]).map((note) => note.reason);
    const text = describeProposal(entry, previous, needsPerson, release);
    const proposal = { entry, previous, needsPerson, release, branch, ...text };
    if (dryRun || !baseCommit) {
      proposed.push(proposal);
      continue;
    }
    try {
      const pullRequest = await github.openPullRequest({
        branch,
        base: baseBranch,
        baseSha: baseCommit.sha,
        path: CATALOG_FILE,
        blobSha: baseCommit.blobSha,
        content,
        ...text,
      });
      proposed.push({ ...proposal, pullRequest });
      if (pullRequest.labelError) {
        warnings.push(`${key}: #${pullRequest.number} has no labels: ${pullRequest.labelError}`);
      }
    } catch (err) {
      errors.push(`${key}: the pull request couldn't be opened: ${errorText(err)}`);
    }
  }
  return result();
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const encodePath = (value: string): string => value.split("/").map(encodeURIComponent).join("/");

/** `CatalogGitHub` over GitHub's REST API. */
export class RestCatalogGitHub implements CatalogGitHub {
  private readonly owner: string;

  constructor(
    private readonly repository: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.owner = repository.split("/")[0];
  }

  private async request(
    method: string,
    route: string,
    { body, raw = false }: { body?: unknown; raw?: boolean } = {}
  ): Promise<string> {
    const response = await this.fetchImpl(`${GITHUB_API}${route}`, {
      method,
      headers: {
        accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "daintree-plugin-catalog",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try {
        detail = String((JSON.parse(text) as { message?: unknown }).message ?? detail);
      } catch {
        // Not JSON: keep the start of the body.
      }
      throw new GitHubApiError(
        `${method} ${route} failed with HTTP ${response.status}: ${detail}`,
        response.status
      );
    }
    return text;
  }

  private async json<T>(method: string, route: string, body?: unknown): Promise<T> {
    const text = await this.request(method, route, { body });
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async listReleases(owner: string, name: string): Promise<readonly Release[]> {
    const route = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases`;
    return this.json<Release[]>("GET", `${route}?per_page=${RELEASES_PER_REPOSITORY}`);
  }

  async pullRequestsFor(branch: string): Promise<readonly PullRequestRef[]> {
    const head = encodeURIComponent(`${this.owner}:${branch}`);
    return this.json<PullRequestRef[]>(
      "GET",
      `/repos/${this.repository}/pulls?state=all&per_page=100&head=${head}`
    );
  }

  async openPullRequests(base: string): Promise<readonly PullRequestRef[]> {
    const all: PullRequestRef[] = [];
    for (let page = 1; page <= OPEN_PULL_REQUEST_PAGES; page++) {
      const batch = await this.json<PullRequestRef[]>(
        "GET",
        `/repos/${this.repository}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100&page=${page}`
      );
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new Error(`more than ${OPEN_PULL_REQUEST_PAGES * 100} open pull requests into ${base}`);
  }

  async catalogAt(ref: string): Promise<string | undefined> {
    try {
      return await this.request(
        "GET",
        `/repos/${this.repository}/contents/${encodePath(CATALOG_FILE)}?ref=${encodeURIComponent(ref)}`,
        { raw: true }
      );
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  async openPullRequest(request: OpenPullRequestRequest): Promise<OpenedPullRequest> {
    const repo = `/repos/${this.repository}`;
    try {
      await this.json("POST", `${repo}/git/refs`, {
        ref: `refs/heads/${request.branch}`,
        sha: request.baseSha,
      });
    } catch (err) {
      if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
      await this.reclaimBranch(request);
    }
    await this.json("PUT", `${repo}/contents/${encodePath(request.path)}`, {
      message: request.title,
      content: Buffer.from(request.content, "utf8").toString("base64"),
      sha: request.blobSha,
      branch: request.branch,
    });
    const pr = await this.json<PullRequestRef>("POST", `${repo}/pulls`, {
      title: request.title,
      head: request.branch,
      base: request.base,
      body: request.body,
    });
    try {
      await this.json("POST", `${repo}/issues/${pr.number}/labels`, { labels: request.labels });
      return pr;
    } catch (err) {
      return { ...pr, labelError: errorText(err) };
    }
  }

  /**
   * The branch exists although no pull request names it: an earlier run
   * stopped between creating it and opening its pull request. It is reset only
   * when it changes nothing but the catalog in at most one commit, so a branch
   * someone else made is never thrown away.
   */
  private async reclaimBranch(request: OpenPullRequestRequest): Promise<void> {
    const repo = `/repos/${this.repository}`;
    const compare = await this.json<{ ahead_by: number; files?: { filename: string }[] }>(
      "GET",
      `${repo}/compare/${request.baseSha}...${encodePath(request.branch)}`
    );
    const files = compare.files ?? [];
    if (compare.ahead_by > 1 || files.some((file) => file.filename !== request.path)) {
      throw new Error(
        `branch ${request.branch} already exists with other changes and no pull request; delete it to let the bot propose this release`
      );
    }
    await this.json("PATCH", `${repo}/git/refs/heads/${encodePath(request.branch)}`, {
      sha: request.baseSha,
      force: true,
    });
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function writeSummary(result: ProposeResult, dryRun: boolean): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  const item = (text: string) => `- ${escapeMarkdown(text)}`;
  const lines = [dryRun ? "## Plugin catalog updates (dry run)" : "## Plugin catalog updates", ""];
  if (result.proposed.length === 0) lines.push("No new release to propose.");
  else {
    lines.push(dryRun ? "### Would propose" : "### Proposed", "");
    for (const proposal of result.proposed) {
      const verdict =
        proposal.needsPerson.length === 0
          ? "quick merge"
          : `needs a person: ${proposal.needsPerson.join("; ")}`;
      const link = proposal.pullRequest
        ? ` [#${proposal.pullRequest.number}](${proposal.pullRequest.html_url})`
        : "";
      lines.push(`${item(`${entryKey(proposal.entry)}, ${verdict}`)}${link}`);
    }
  }
  if (result.skipped.length > 0) {
    lines.push("", "### Skipped", "", ...result.skipped.map((s) => item(`${s.what}: ${s.reason}`)));
  }
  if (result.warnings.length > 0) lines.push("", "### Warnings", "", ...result.warnings.map(item));
  if (result.errors.length > 0) lines.push("", "### Failed", "", ...result.errors.map(item));
  appendFileSync(summaryFile, `${lines.join("\n")}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const catalogPath = argValue(argv, "--catalog");
  let dryRun = argv.includes("--dry-run");
  if (catalogPath && !dryRun) {
    throw new Error("--catalog needs --dry-run: a pull request starts from the committed catalog");
  }
  const botToken = process.env.PLUGIN_CATALOG_BOT_TOKEN || undefined;
  if (!dryRun && !botToken) {
    const notice =
      "PLUGIN_CATALOG_BOT_TOKEN isn't set, so this run opens nothing and only lists what it would propose. .github/workflows/README.md says how to create it.";
    console.log(`::notice::${escapeAnnotation(notice)}`);
    dryRun = true;
  }
  const token = botToken ?? (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined);
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: PLUGIN_CATALOG_MAX_BYTES * 4,
    });
  const catalogText = catalogPath
    ? readFileSync(catalogPath, "utf8")
    : git("show", `HEAD:${CATALOG_FILE}`);
  const baseCommit = catalogPath
    ? undefined
    : {
        sha: git("rev-parse", "HEAD").trim(),
        blobSha: git("rev-parse", `HEAD:${CATALOG_FILE}`).trim(),
      };

  const result = await proposeCatalogUpdates({
    catalogText,
    github: new RestCatalogGitHub(repository, token),
    baseBranch: process.env.PLUGIN_CATALOG_BASE || DEFAULT_BASE_BRANCH,
    baseCommit,
    dryRun,
  });

  for (const proposal of result.proposed) {
    const key = entryKey(proposal.entry);
    const verdict = proposal.needsPerson.length === 0 ? "quick merge" : "needs a person";
    if (proposal.pullRequest) {
      console.log(`[catalog] opened ${proposal.pullRequest.html_url} for ${key} (${verdict})`);
    } else {
      console.log(`[catalog] would propose ${key} on ${proposal.branch} (${verdict})`);
      console.log(JSON.stringify(proposal.entry, null, 2));
      console.log(`\n${proposal.title}\n\n${proposal.body}`);
    }
  }
  for (const skip of result.skipped) console.log(`[catalog] skipped ${skip.what}: ${skip.reason}`);
  for (const warning of result.warnings) console.log(`::warning::${escapeAnnotation(warning)}`);
  for (const error of result.errors) console.error(`::error::${escapeAnnotation(error)}`);
  writeSummary(result, dryRun);
  if (result.proposed.length === 0) console.log("[catalog] no new release to propose");
  return result.errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`::error::${escapeAnnotation(errorText(err))}`);
    return 1;
  });
}
