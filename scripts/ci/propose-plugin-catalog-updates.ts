#!/usr/bin/env -S npx tsx
// Opens a catalog pull request for each new release of a listed plugin
// (#16780). For every repository the catalog lists, it reads the newest GitHub
// releases, downloads each `.dntr` asset that could be new, and proposes an
// entry built from those bytes: their SHA-256, and the id, version and
// capabilities of the manifest inside. Each pull request says whether the
// repository and capabilities match the plugin's previous entry. A person
// merges every one of them; plugins/README.md says why.
//
//   npx tsx scripts/ci/propose-plugin-catalog-updates.ts [--dry-run] [--catalog <path>]
//
// A dry run reads GitHub and downloads assets but opens nothing. --catalog
// (dry runs only) reads that file instead of the committed catalog. Reads
// GITHUB_TOKEN, PLUGIN_CATALOG_BOT_TOKEN when set, and GITHUB_REPOSITORY.

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
import {
  CATALOG_FILE,
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
const DEFAULT_BASE_BRANCH = "develop";
/** GitHub lists releases newest first; anything older than this is long settled. */
const RELEASES_PER_REPOSITORY = 30;
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
  openPullRequest(request: OpenPullRequestRequest): Promise<OpenedPullRequest>;
}

export interface WatchedRepository {
  readonly owner: string;
  readonly name: string;
  /** The newest entry of each plugin whose newest entry names this repository. */
  readonly newest: ReadonlyMap<string, PluginCatalogEntry>;
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
  /** The catalog's text at `base.sha`. */
  readonly catalogText: string;
  readonly github: CatalogGitHub;
  /** Where pull requests start. Required unless `dryRun`. */
  readonly base?: { readonly branch: string; readonly sha: string; readonly blobSha: string };
  readonly dryRun?: boolean;
  /** Whether a pull request opened with this token starts CI. */
  readonly ciStarts: boolean;
  readonly download?: DownloadOptions;
  readonly tmpRoot?: string;
  readonly format?: (text: string) => Promise<string>;
}

const entryKey = (entry: Pick<PluginCatalogEntry, "id" | "version">): string =>
  `${entry.id}@${entry.version}`;

export const branchName = (entry: Pick<PluginCatalogEntry, "id" | "version">): string =>
  `${BRANCH_PREFIX}${entry.id}-${entry.version}`;

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
 * The repositories to watch: the one each plugin's newest entry names, so a
 * plugin that moved is watched where it went. Names compare without case, as
 * GitHub does.
 */
export function watchedRepositories(entries: readonly PluginCatalogEntry[]): WatchedRepository[] {
  const byRepo = new Map<
    string,
    { owner: string; name: string; newest: Map<string, PluginCatalogEntry> }
  >();
  for (const entry of newestEntries(entries).values()) {
    const [owner, name] = new URL(entry.repo).pathname.split("/").slice(1);
    const key = `${owner}/${name}`.toLowerCase();
    let repo = byRepo.get(key);
    if (!repo) {
      repo = { owner, name, newest: new Map() };
      byRepo.set(key, repo);
    }
    repo.newest.set(entry.id, entry);
  }
  return [...byRepo.values()];
}

const isPlainSemver = (value: string): boolean => semver.valid(value) === value;

/**
 * Whether an asset can't hold a release newer than what's listed, judged before
 * downloading it: by its file name as `daintree-plugin package` writes it,
 * `{id}-{version}.dntr`, or failing that by its release's tag. Only ever used
 * to skip a download; the manifest decides what is proposed.
 */
export function cannotBeNew(
  asset: ReleaseAsset,
  release: Release,
  watched: WatchedRepository
): boolean {
  for (const [id, newest] of watched.newest) {
    const prefix = `${id}-`;
    if (!asset.name.startsWith(prefix)) continue;
    const version = asset.name.slice(prefix.length, -".dntr".length);
    if (isPlainSemver(version)) return !semver.gt(version, newest.version);
  }
  const tagVersion = release.tag_name.replace(/^v/, "");
  if (!isPlainSemver(tagVersion)) return false;
  return [...watched.newest.values()].every((newest) => !semver.gt(tagVersion, newest.version));
}

/** `https://github.com/{owner}/{repo}`, from a release asset's download URL. */
export function repoOfAssetUrl(url: string): string {
  const [owner, name] = new URL(url).pathname.split("/").slice(1);
  return `https://github.com/${owner}/${name}`;
}

export async function formatCatalog(text: string): Promise<string> {
  const prettier = await import("prettier");
  const filepath = path.join(repoRoot, CATALOG_FILE);
  const config = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(text, { ...config, filepath });
}

/**
 * The catalog with `entry` added after the plugin's last entry in the file, so
 * pull requests for different plugins touch different lines.
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

const code = (text: string): string => `\`${text.replace(/[`\r\n]/g, "")}\``;
const capabilityList = (capabilities: readonly string[]): string =>
  capabilities.length === 0 ? "none" : capabilities.map(code).join(", ");

/** The pull request's title, body and labels. */
export function describeProposal(
  entry: PluginCatalogEntry,
  previous: PluginCatalogEntry,
  needsPerson: readonly string[],
  release: Release,
  ciStarts: boolean
): { title: string; body: string; labels: string[] } {
  const title = `chore(catalog): add ${entry.id} ${entry.version}`;
  const removed = previous.capabilities.filter((cap) => !entry.capabilities.includes(cap));
  const sameRepo = previous.repo.toLowerCase() === entry.repo.toLowerCase();
  const lines = [
    `Adds ${code(entry.id)} ${code(entry.version)} to the plugin catalog, from the release [${escapeMarkdown(release.tag_name)}](${release.html_url}).`,
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
    `| Capabilities | ${capabilityList(previous.capabilities)} | ${capabilityList(entry.capabilities)} |`
  );
  if (removed.length > 0) {
    lines.push("", `Capabilities no longer declared: ${capabilityList(removed)}.`);
  }
  lines.push(
    "",
    "The SHA-256 is of the asset as downloaded, and the archive passed the installer's own check; the id, version and capabilities come from its manifest. The `plugin-catalog` check downloads it again.",
    "",
    "Merging is a person's decision either way: a quick merge means the release matches what was reviewed before, not that it was reviewed again. Review confirms the source and the bytes, never that the code is safe."
  );
  if (!ciStarts) {
    lines.push(
      "",
      "> [!NOTE]",
      "> Opened with the workflow's own token, which starts no checks. Close and reopen this pull request to run CI."
    );
  }
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

/**
 * Find every release of a watched repository that's newer than its plugin's
 * newest entry and has no pull request yet, in any state, and open one for it.
 * A closed pull request counts: a person declined that release, or it merged
 * and was later delisted, and neither should be proposed again.
 */
export async function proposeCatalogUpdates({
  catalogText,
  github,
  base,
  dryRun = false,
  ciStarts,
  download = {},
  tmpRoot = os.tmpdir(),
  format = formatCatalog,
}: ProposeOptions): Promise<ProposeResult> {
  const proposed: Proposal[] = [];
  const skipped: SkippedRelease[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const result = () => ({ proposed, skipped, warnings, errors });

  if (!dryRun && !base) throw new Error("a base commit is needed to open pull requests");
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
  const seen = new Set<string>();

  const workDir = await mkdtemp(path.join(tmpRoot, "plugin-catalog-propose-"));
  try {
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
        for (const asset of release.assets) {
          if (!asset.name.endsWith(".dntr") || cannotBeNew(asset, release, watched)) continue;
          const what = `${repoName} ${release.tag_name} ${asset.name}`;
          const archivePath = path.join(workDir, `${seen.size}-${proposed.length}.dntr`);
          const inspected = await inspectAsset(asset, archivePath, download);
          if (typeof inspected === "string") {
            warnings.push(`${what}: ${inspected}`);
            continue;
          }
          const previous = newest.get(inspected.id);
          if (!previous) {
            skipped.push({
              what,
              reason: `${inspected.id} isn't listed; a first listing is its author's pull request`,
            });
            continue;
          }
          if (!semver.gt(inspected.version, previous.version)) {
            skipped.push({
              what,
              reason: `${inspected.version} isn't newer than the listed ${previous.version}`,
            });
            continue;
          }
          const entry: PluginCatalogEntry = {
            id: inspected.id,
            repo: repoOfAssetUrl(asset.browser_download_url),
            version: inspected.version,
            url: asset.browser_download_url,
            sha256: inspected.sha256,
            capabilities: inspected.capabilities,
          };
          const key = entryKey(entry);
          if (seen.has(key)) continue;
          seen.add(key);

          let content: string;
          try {
            content = await catalogWithEntry(catalogText, entry, format);
          } catch (err) {
            errors.push(`${key}: the catalog couldn't be rewritten: ${errorText(err)}`);
            continue;
          }
          const check = parsePluginCatalog(JSON.parse(content));
          if (!check.ok) {
            warnings.push(`${what}: its entry would make the catalog invalid: ${check.error}`);
            continue;
          }

          const branch = branchName(entry);
          let existing: readonly PullRequestRef[];
          try {
            existing = await github.pullRequestsFor(branch);
          } catch (err) {
            errors.push(`${key}: its pull requests couldn't be read: ${errorText(err)}`);
            continue;
          }
          if (existing.length > 0) {
            const pr = existing[0];
            skipped.push({
              what,
              reason: `pull request #${pr.number} (${pr.merged_at ? "merged" : pr.state}) already proposed ${key}`,
            });
            continue;
          }

          const needsPerson = entriesNeedingPerson(entries, [entry]).map((note) => note.reason);
          const text = describeProposal(entry, previous, needsPerson, release, ciStarts);
          const proposal = { entry, previous, needsPerson, release, branch, ...text };
          if (dryRun || !base) {
            proposed.push(proposal);
            continue;
          }
          try {
            const pullRequest = await github.openPullRequest({
              branch,
              base: base.branch,
              baseSha: base.sha,
              path: CATALOG_FILE,
              blobSha: base.blobSha,
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
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  return result();
}

class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const encodePath = (value: string): string =>
  value.split("/").map(encodeURIComponent).join("/");

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

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${GITHUB_API}${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
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
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async listReleases(owner: string, name: string): Promise<readonly Release[]> {
    const route = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases`;
    return this.call<Release[]>("GET", `${route}?per_page=${RELEASES_PER_REPOSITORY}`);
  }

  async pullRequestsFor(branch: string): Promise<readonly PullRequestRef[]> {
    const head = encodeURIComponent(`${this.owner}:${branch}`);
    return this.call<PullRequestRef[]>(
      "GET",
      `/repos/${this.repository}/pulls?state=all&per_page=100&head=${head}`
    );
  }

  async openPullRequest(request: OpenPullRequestRequest): Promise<OpenedPullRequest> {
    const repo = `/repos/${this.repository}`;
    try {
      await this.call("POST", `${repo}/git/refs`, {
        ref: `refs/heads/${request.branch}`,
        sha: request.baseSha,
      });
    } catch (err) {
      // Left behind by a run that stopped before opening its pull request, the
      // only way it can exist when no pull request names it.
      if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
      await this.call("PATCH", `${repo}/git/refs/heads/${encodePath(request.branch)}`, {
        sha: request.baseSha,
        force: true,
      });
    }
    await this.call("PUT", `${repo}/contents/${encodePath(request.path)}`, {
      message: request.title,
      content: Buffer.from(request.content, "utf8").toString("base64"),
      sha: request.blobSha,
      branch: request.branch,
    });
    const pr = await this.call<PullRequestRef>("POST", `${repo}/pulls`, {
      title: request.title,
      head: request.branch,
      base: request.base,
      body: request.body,
    });
    try {
      await this.call("POST", `${repo}/issues/${pr.number}/labels`, {
        labels: request.labels,
      });
      return pr;
    } catch (err) {
      return { ...pr, labelError: errorText(err) };
    }
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
    lines.push("### Proposed", "");
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
  const dryRun = argv.includes("--dry-run");
  const catalogPath = argValue(argv, "--catalog");
  if (catalogPath && !dryRun) {
    throw new Error("--catalog needs --dry-run: a pull request starts from the committed catalog");
  }
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const botToken = process.env.PLUGIN_CATALOG_BOT_TOKEN || undefined;
  const token = botToken ?? (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined);
  if (!dryRun && !token) throw new Error("GITHUB_TOKEN is needed to open pull requests");

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const catalogText = catalogPath
    ? readFileSync(catalogPath, "utf8")
    : git("show", `HEAD:${CATALOG_FILE}`);
  const base = catalogPath
    ? undefined
    : {
        branch: process.env.PLUGIN_CATALOG_BASE || DEFAULT_BASE_BRANCH,
        sha: git("rev-parse", "HEAD").trim(),
        blobSha: git("rev-parse", `HEAD:${CATALOG_FILE}`).trim(),
      };

  const result = await proposeCatalogUpdates({
    catalogText,
    github: new RestCatalogGitHub(repository, token),
    base,
    dryRun,
    ciStarts: Boolean(botToken),
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
