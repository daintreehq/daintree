import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packPluginArchive } from "../../electron/services/PluginArchive.js";
import {
  parsePluginCatalog,
  type PluginCatalogEntry,
} from "../../electron/services/plugin/pluginCatalogSchema.js";
import { PLUGIN_CATALOG_MAX_BYTES } from "../../shared/config/pluginCatalog.js";
import { CATALOG_FILE } from "./check-plugin-catalog.js";
import {
  GitHubApiError,
  LABELS,
  RestCatalogGitHub,
  branchName,
  cannotBeNew,
  catalogWithEntry,
  describeProposal,
  formatCatalog,
  proposeCatalogUpdates,
  rewriteProblem,
  runMode,
  watchedRepositories,
  type CatalogGitHub,
  type OpenPullRequestRequest,
  type PullRequestRef,
  type Release,
} from "./propose-plugin-catalog-updates.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = "https://github.com/acme/widget-plugin";
const CAPS = ["fs:user-data-read", "mcp:expose"];
const BASE = { sha: "b".repeat(40), blobSha: "c".repeat(40) };

let tmpDir: string;
/** Fixture archives by name, served at any asset URL whose file name maps to one. */
const archives = new Map<string, Buffer>();
const served = new Map<string, Buffer>();

async function pack(
  name: string,
  manifest: Record<string, unknown>,
  body = "export {};\n"
): Promise<Buffer> {
  const src = path.join(tmpDir, name);
  await mkdir(path.join(src, "dist"), { recursive: true });
  await writeFile(path.join(src, "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(src, "dist", "index.js"), body);
  const out = path.join(tmpDir, `${name}.dntr`);
  await packPluginArchive(src, out);
  return readFile(out);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function listed(version: string, overrides: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry {
  const repo = overrides.repo ?? REPO;
  return {
    id: "acme.widget",
    repo,
    version,
    url: `${repo}/releases/download/v${version}/acme.widget-${version}.dntr`,
    sha256: "a".repeat(64),
    capabilities: CAPS,
    ...overrides,
  };
}

/** A release whose assets serve the named fixture archives. */
function release(
  tag: string,
  assets: Array<[assetName: string, archive: string]>,
  { repo = REPO, ...flags }: { repo?: string; draft?: boolean; prerelease?: boolean } = {}
): Release {
  return {
    tag_name: tag,
    html_url: `${repo}/releases/tag/${tag}`,
    draft: flags.draft ?? false,
    prerelease: flags.prerelease ?? false,
    assets: assets.map(([name, archive]) => {
      const url = `${repo}/releases/download/${tag}/${name}`;
      const bytes = archives.get(archive);
      if (bytes) served.set(url, bytes);
      return { name, browser_download_url: url };
    }),
  };
}

function servingFetch() {
  return vi.fn(async (url: string) => {
    const bytes = served.get(url);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("missing", { status: 404 });
  });
}

const noSleep = () => Promise.resolve();

class FakeGitHub implements CatalogGitHub {
  releases = new Map<string, readonly Release[] | Error>();
  byBranch = new Map<string, PullRequestRef[]>();
  open: PullRequestRef[] = [];
  openError?: Error;
  catalogs = new Map<string, string>();
  opened: OpenPullRequestRequest[] = [];
  failOpening = new Set<string>();

  listReleases = vi.fn(async (owner: string, name: string) => {
    const found = this.releases.get(`${owner}/${name}`.toLowerCase());
    if (found instanceof Error) throw found;
    return found ?? [];
  });

  pullRequestsFor = vi.fn(async (branch: string) => this.byBranch.get(branch) ?? []);

  openPullRequests = vi.fn(async () => {
    if (this.openError) throw this.openError;
    return this.open;
  });

  catalogAt = vi.fn(async (ref: string) => this.catalogs.get(ref));

  openPullRequest = vi.fn(async (request: OpenPullRequestRequest) => {
    if (this.failOpening.has(request.branch)) throw new Error("HTTP 502");
    this.opened.push(request);
    const number = 100 + this.opened.length;
    return {
      number,
      html_url: `https://github.com/daintreehq/daintree/pull/${number}`,
      state: "open",
    };
  });
}

const catalogText = async (entries: PluginCatalogEntry[], extra: Record<string, unknown> = {}) =>
  formatCatalog(`${JSON.stringify({ ...extra, entries }, null, 2)}\n`);

async function run(
  github: FakeGitHub,
  entries: PluginCatalogEntry[] = [listed("1.0.0")],
  options: { dryRun?: boolean; fetch?: ReturnType<typeof servingFetch> } = {}
) {
  const fetch = options.fetch ?? servingFetch();
  const result = await proposeCatalogUpdates({
    catalogText: await catalogText(entries),
    github,
    baseCommit: BASE,
    dryRun: options.dryRun,
    download: { fetch, sleep: noSleep },
    tmpRoot: tmpDir,
  });
  return { result, fetch };
}

const openedEntries = (request: OpenPullRequestRequest) => {
  const parsed = parsePluginCatalog(JSON.parse(request.content));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.catalog.entries;
};

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "propose-plugin-catalog-test-"));
  const widget = (version: string, capabilities = CAPS) =>
    pack(`widget-${version}`, { name: "acme.widget", version, capabilities });
  archives.set("1.1.0", await widget("1.1.0"));
  archives.set("1.2.0", await widget("1.2.0", [...CAPS, "network:fetch"]));
  archives.set("0.9.0", await widget("0.9.0"));
  archives.set("2.0.0-beta.1", await widget("2.0.0-beta.1"));
  archives.set(
    "1.1.0-rebuilt",
    await pack(
      "widget-rebuilt",
      { name: "acme.widget", version: "1.1.0", capabilities: CAPS },
      "1;\n"
    )
  );
  archives.set("other", await pack("other", { name: "acme.other", version: "1.0.0" }));
  archives.set("gadget", await pack("gadget", { name: "acme.gadget", version: "5.0.0" }));
  archives.set("broken", Buffer.from("not a zip archive"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("watchedRepositories", () => {
  it("watches each repository once, with every plugin listed from it", () => {
    const moved = "https://github.com/acme/widget-next";
    const gadget = listed("1.0.0", {
      id: "acme.gadget",
      repo: REPO.replace("acme/widget-plugin", "Acme/Widget-Plugin"),
    });
    const watched = watchedRepositories([
      listed("1.0.0"),
      listed("2.0.0", { repo: moved }),
      gadget,
    ]);
    expect(watched.map((w) => [`${w.owner}/${w.name}`, [...w.ids].sort()])).toEqual([
      ["acme/widget-plugin", ["acme.gadget", "acme.widget"]],
      ["acme/widget-next", ["acme.widget"]],
    ]);
  });
});

describe("cannotBeNew", () => {
  const entries = [listed("1.0.0"), listed("3.0.0", { id: "acme.widget-pro" })];
  const [watched] = watchedRepositories(entries);
  const newest = new Map(entries.map((entry) => [entry.id, entry]));
  const asset = (name: string) => ({ name, browser_download_url: `${REPO}/x/${name}` });

  it("skips a packaged name at or below the newest entry", () => {
    expect(cannotBeNew(asset("acme.widget-1.0.0.dntr"), watched, newest)).toBe(true);
    expect(cannotBeNew(asset("acme.widget-0.9.9.dntr"), watched, newest)).toBe(true);
    expect(cannotBeNew(asset("acme.widget-1.0.1.dntr"), watched, newest)).toBe(false);
  });

  it("downloads any name that reads as a prerelease, since the packager drops `+`", () => {
    // 1.1.1+1-linux is packaged as acme.widget-1.1.11-linux.dntr.
    expect(cannotBeNew(asset("acme.widget-1.1.11-linux.dntr"), watched, newest)).toBe(false);
    expect(cannotBeNew(asset("acme.widget-0.9.0-rc.1.dntr"), watched, newest)).toBe(false);
    // 1.1.1+-linux is packaged as acme.widget-1.1.1-linux.dntr, which sorts
    // below a listed 1.1.1-rc.1 although the release itself is newer.
    const rc = listed("1.1.1-rc.1");
    const [rcWatched] = watchedRepositories([rc]);
    const rcNewest = new Map([[rc.id, rc]]);
    expect(cannotBeNew(asset("acme.widget-1.1.1-linux.dntr"), rcWatched, rcNewest)).toBe(false);
  });

  it("matches a name to the right plugin when one id begins another", () => {
    expect(cannotBeNew(asset("acme.widget-pro-2.0.0.dntr"), watched, newest)).toBe(true);
    expect(cannotBeNew(asset("acme.widget-pro-3.0.1.dntr"), watched, newest)).toBe(false);
  });

  it("downloads anything its name doesn't place", () => {
    expect(cannotBeNew(asset("widget.dntr"), watched, newest)).toBe(false);
    expect(cannotBeNew(asset("acme.widget-v1.0.0.dntr"), watched, newest)).toBe(false);
  });
});

describe("branchName", () => {
  it("gives two builds of one version their own ref-safe branches", () => {
    const branches = ["1.2.0", "1.2.0+x.lock", "1.2.0+y.lock"].map((version) =>
      branchName({ id: "acme.widget", version })
    );
    expect(new Set(branches).size).toBe(3);
    for (const branch of branches) {
      expect(branch).toMatch(/^plugin-catalog\/acme\.widget-1\.2\.0(-build-[0-9a-f]+)?$/);
    }
  });
});

describe("catalogWithEntry", () => {
  it("adds the entry after the plugin's last one and keeps everything else", async () => {
    const before = [listed("1.0.0"), listed("1.0.0", { id: "acme.gadget" }), listed("0.5.0")];
    const text = await catalogText(before, { $comment: "kept" });
    const added = listed("1.1.0", { sha256: "d".repeat(64) });
    const content = await catalogWithEntry(text, added);

    const raw = JSON.parse(content) as { $comment: string; entries: PluginCatalogEntry[] };
    expect(raw.$comment).toBe("kept");
    expect(raw.entries).toEqual([before[0], before[1], before[2], added]);
    expect(rewriteProblem(before, content, added)).toBeUndefined();
    const prettier = await import("prettier");
    const filepath = path.join(repoRoot, CATALOG_FILE);
    const config = (await prettier.resolveConfig(filepath)) ?? {};
    expect(await prettier.check(content, { ...config, filepath })).toBe(true);
  });

  it("groups the entry with its plugin rather than appending it", async () => {
    const before = [listed("1.0.0"), listed("1.0.0", { id: "acme.gadget" })];
    const content = await catalogWithEntry(await catalogText(before), listed("1.1.0"));
    const ids = (JSON.parse(content) as { entries: PluginCatalogEntry[] }).entries.map(
      (e) => `${e.id}@${e.version}`
    );
    expect(ids).toEqual(["acme.widget@1.0.0", "acme.widget@1.1.0", "acme.gadget@1.0.0"]);
  });
});

describe("rewriteProblem", () => {
  it("refuses a rewrite that changes another entry or outgrows what the app reads", () => {
    const before = [listed("1.0.0"), listed("0.9.0")];
    const added = listed("1.1.0");
    const dropped = JSON.stringify({ entries: [before[0], added] });
    expect(rewriteProblem(before, dropped, added)).toMatch(/more than the one entry/);
    const edited = JSON.stringify({
      entries: [{ ...before[0], capabilities: [] }, before[1], added],
    });
    expect(rewriteProblem(before, edited, added)).toMatch(/more than the one entry/);
    const padded = `${JSON.stringify({ entries: [...before, added] })}${" ".repeat(PLUGIN_CATALOG_MAX_BYTES)}`;
    expect(rewriteProblem(before, padded, added)).toMatch(/byte limit/);
  });
});

describe("describeProposal", () => {
  it("keeps a hostile tag inside its code span", () => {
    const tag = "v1.1.0`](https://evil.example)\n# Approved | x";
    const { body } = describeProposal(listed("1.1.0"), listed("1.0.0"), [], release(tag, []));
    expect(body).toContain("`v1.1.0](https://evil.example)# Approved  x`");
    expect(body).not.toMatch(/^# /m);
  });

  it("says when capabilities were dropped or only reordered, neither of which needs a person", () => {
    const previous = listed("1.0.0", { capabilities: [...CAPS, "network:fetch"] });
    const dropped = describeProposal(listed("1.1.0"), previous, [], release("v1.1.0", []));
    expect(dropped.body).toContain("Capabilities no longer declared: `network:fetch`.");
    expect(dropped.labels).toEqual([LABELS.catalog, LABELS.quickMerge]);

    const reordered = listed("1.1.0", { capabilities: [...CAPS].reverse() });
    const { body } = describeProposal(reordered, listed("1.0.0"), [], release("v1.1.0", []));
    expect(body).toContain("The same capabilities, in a different order.");
  });
});

describe("proposeCatalogUpdates", () => {
  it("opens one pull request per new release, built from the downloaded bytes", async () => {
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", [
      release("v1.2.0", [["acme.widget-1.2.0.dntr", "1.2.0"]]),
      release("v1.1.0", [
        ["acme.widget-1.1.0.dntr", "1.1.0"],
        ["SHA256SUMS", "none"],
      ]),
      release("v1.0.0", [["acme.widget-1.0.0.dntr", "none"]]),
    ]);
    const { result, fetch } = await run(github);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(github.opened.map((pr) => pr.branch)).toEqual([
      "plugin-catalog/acme.widget-1.2.0",
      "plugin-catalog/acme.widget-1.1.0",
    ]);

    const [newCapability, quick] = github.opened;
    expect(quick).toMatchObject({
      base: "develop",
      baseSha: BASE.sha,
      blobSha: BASE.blobSha,
      path: CATALOG_FILE,
      title: "chore(catalog): add acme.widget 1.1.0",
      labels: [LABELS.catalog, LABELS.quickMerge],
    });
    expect(quick.body).toContain("**Quick merge.**");
    // Each pull request adds its own release to the catalog as it is, and
    // nothing else.
    expect(openedEntries(quick)).toEqual([
      listed("1.0.0"),
      {
        id: "acme.widget",
        repo: REPO,
        version: "1.1.0",
        url: `${REPO}/releases/download/v1.1.0/acme.widget-1.1.0.dntr`,
        sha256: sha256(archives.get("1.1.0")!),
        capabilities: CAPS,
      },
    ]);
    expect(openedEntries(newCapability).map((e) => e.version)).toEqual(["1.0.0", "1.2.0"]);
    expect(newCapability.labels).toEqual([LABELS.catalog, LABELS.needsPerson]);
    expect(newCapability.body).toContain("new capabilities since 1.0.0: network:fetch");
    expect(result.proposed.map((p) => p.pullRequest?.number)).toEqual([101, 102]);
  });

  it("compares with the plugin's newest entry by semver, wherever it sits in the file", async () => {
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", [
      release("v1.2.0", [["acme.widget-1.2.0.dntr", "1.2.0"]]),
      release("v0.9.0", [["widget-0.9.0.dntr", "0.9.0"]]),
    ]);
    const entries = [listed("0.5.0"), listed("1.1.0"), listed("0.8.0")];
    const { result } = await run(github, entries);

    expect(result.skipped.map((s) => s.reason)).toEqual([
      "0.9.0 isn't newer than the listed 1.1.0",
    ]);
    expect(result.proposed.map((p) => [p.entry.version, p.previous.version])).toEqual([
      ["1.2.0", "1.1.0"],
    ]);
    expect(github.opened[0].body).toContain("new capabilities since 1.1.0: network:fetch");
  });

  it("skips drafts, GitHub prereleases and prerelease manifests", async () => {
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", [
      release("v1.1.0", [["acme.widget-1.1.0.dntr", "1.1.0"]], { draft: true }),
      release("v1.2.0", [["acme.widget-1.2.0.dntr", "1.2.0"]], { prerelease: true }),
      release("beta", [["widget.dntr", "2.0.0-beta.1"]]),
    ]);
    const { result, fetch } = await run(github);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(github.opened).toEqual([]);
    expect(result.skipped).toEqual([
      { what: "acme/widget-plugin beta widget.dntr", reason: "2.0.0-beta.1 is a prerelease" },
    ]);
  });

  it("skips a release that already has a pull request: its own in any state, or anyone's open one", async () => {
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", [
      release("v1.2.0", [["acme.widget-1.2.0.dntr", "1.2.0"]]),
      release("v1.1.0", [["acme.widget-1.1.0.dntr", "1.1.0"]]),
    ]);
    github.byBranch.set("plugin-catalog/acme.widget-1.1.0", [
      { number: 5, html_url: "https://github.com/x/pull/5", state: "closed", merged_at: null },
    ]);
    const authorsOwn = { number: 7, html_url: "https://github.com/x/pull/7", state: "open" };
    github.open = [
      { number: 6, html_url: "https://github.com/x/pull/6", state: "open" },
      authorsOwn,
    ];
    github.catalogs.set("refs/pull/7/head", await catalogText([listed("1.0.0"), listed("1.2.0")]));
    const { result } = await run(github);

    expect(github.opened).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "pull request #7 (open) already proposed acme.widget@1.2.0",
      "pull request #5 (closed) already proposed acme.widget@1.1.0",
    ]);
    expect(github.catalogAt).toHaveBeenCalledWith("refs/pull/6/head");
  });

  it("proposes only plugins listed from the repository that released them", async () => {
    const gadgetRepo = "https://github.com/acme/gadget";
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", [
      release("v9", [
        ["acme.other-1.0.0.dntr", "other"],
        ["acme.gadget-5.0.0.dntr", "gadget"],
      ]),
    ]);
    const entries = [
      listed("1.0.0"),
      listed("4.0.0", {
        id: "acme.gadget",
        repo: gadgetRepo,
        url: `${gadgetRepo}/releases/download/v4.0.0/acme.gadget-4.0.0.dntr`,
      }),
    ];
    const { result } = await run(github, entries);

    expect(github.opened).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "acme.other isn't listed; a first listing is its author's pull request",
      "acme.gadget isn't listed from acme/widget-plugin",
    ]);
  });

  it("goes by the manifest's version, not the asset's name or tag", async () => {
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", [release("v5.0.0", [["widget.dntr", "0.9.0"]])]);
    const { result } = await run(github);

    expect(github.opened).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "0.9.0 isn't newer than the listed 1.0.0",
    ]);
  });

  it("names the new repository of a plugin whose repository moved, and wants a person for it", async () => {
    const moved = "https://github.com/acme-labs/widget-plugin";
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", [
      release("v1.1.0", [["acme.widget-1.1.0.dntr", "1.1.0"]], { repo: moved }),
    ]);
    const { result } = await run(github);

    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0].entry.repo).toBe(moved);
    expect(result.proposed[0].needsPerson).toEqual([
      `repository changed from ${REPO} (1.0.0) to ${moved}`,
    ]);
    expect(github.opened[0].labels).toContain(LABELS.needsPerson);
  });

  it("refuses an asset outside its release's repository without downloading it", async () => {
    const github = new FakeGitHub();
    const elsewhere = release("v1.1.0", [["acme.widget-1.1.0.dntr", "1.1.0"]], {
      repo: "https://github.com/mallory/widget-plugin",
    });
    github.releases.set("acme/widget-plugin", [
      { ...elsewhere, html_url: `${REPO}/releases/tag/v1.1.0` },
    ]);
    const { result, fetch } = await run(github);

    expect(fetch).not.toHaveBeenCalled();
    expect(github.opened).toEqual([]);
    expect(result.warnings).toEqual([
      `acme/widget-plugin v1.1.0 acme.widget-1.1.0.dntr: the asset isn't under its release's repository ${REPO}`,
    ]);
  });

  it("warns and carries on past an unreadable repository and a broken asset", async () => {
    const gadgetRepo = "https://github.com/acme/gadget";
    const github = new FakeGitHub();
    github.releases.set("acme/gadget", new GitHubApiError("HTTP 404", 404));
    github.releases.set("acme/widget-plugin", [
      release("v1.2.0", [["widget-1.2.0.dntr", "broken"]]),
      release("v1.1.0", [["acme.widget-1.1.0.dntr", "1.1.0"]]),
    ]);
    const entries = [
      listed("4.0.0", {
        id: "acme.gadget",
        repo: gadgetRepo,
        url: `${gadgetRepo}/releases/download/v4.0.0/acme.gadget-4.0.0.dntr`,
      }),
      listed("1.0.0"),
    ];
    const { result } = await run(github, entries);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toBe("acme/gadget: its releases couldn't be read: HTTP 404");
    expect(result.warnings[1]).toMatch(
      /^acme\/widget-plugin v1\.2\.0 widget-1\.2\.0\.dntr: it isn't an installable \.dntr/
    );
    expect(github.opened.map((pr) => pr.branch)).toEqual(["plugin-catalog/acme.widget-1.1.0"]);
  });

  it("fails when GitHub refuses the token, rather than pass while watching nothing", async () => {
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", new GitHubApiError("HTTP 401: Bad credentials", 401));
    const { result } = await run(github);

    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([
      "acme/widget-plugin: its releases couldn't be read: HTTP 401: Bad credentials",
    ]);
  });

  it("proposes neither of two different assets that claim the same release", async () => {
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", [
      release("v1.1.0-again", [["widget.dntr", "1.1.0-rebuilt"]]),
      release("v1.1.0", [["acme.widget-1.1.0.dntr", "1.1.0"]]),
    ]);
    const { result } = await run(github);

    expect(github.opened).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/^acme\.widget@1\.1\.0: 2 different assets claim it/),
    ]);
  });

  it("reports a pull request it couldn't open, and still opens the rest", async () => {
    const github = new FakeGitHub();
    github.failOpening.add("plugin-catalog/acme.widget-1.2.0");
    github.releases.set("acme/widget-plugin", [
      release("v1.2.0", [["acme.widget-1.2.0.dntr", "1.2.0"]]),
      release("v1.1.0", [["acme.widget-1.1.0.dntr", "1.1.0"]]),
    ]);
    const { result } = await run(github);

    expect(result.errors).toEqual([
      "acme.widget@1.2.0: the pull request couldn't be opened: HTTP 502",
    ]);
    expect(github.opened.map((pr) => pr.branch)).toEqual(["plugin-catalog/acme.widget-1.1.0"]);
  });

  it("opens nothing when the open pull requests can't be checked", async () => {
    const github = new FakeGitHub();
    github.openError = new Error("HTTP 500");
    github.releases.set("acme/widget-plugin", [
      release("v1.1.0", [["acme.widget-1.1.0.dntr", "1.1.0"]]),
    ]);
    const { result } = await run(github);

    expect(github.opened).toEqual([]);
    expect(result.errors).toEqual([
      "acme.widget@1.1.0: pull requests couldn't be read, so none is opened: HTTP 500",
    ]);
  });

  it("lists what it would propose on a dry run and opens nothing", async () => {
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", [
      release("v1.1.0", [["acme.widget-1.1.0.dntr", "1.1.0"]]),
    ]);
    const { result } = await run(github, undefined, { dryRun: true });

    expect(github.openPullRequest).not.toHaveBeenCalled();
    expect(result.proposed.map((p) => [p.branch, p.pullRequest])).toEqual([
      ["plugin-catalog/acme.widget-1.1.0", undefined],
    ]);
  });

  it("reads no release when the catalog doesn't parse", async () => {
    const github = new FakeGitHub();
    const result = await proposeCatalogUpdates({
      catalogText: JSON.stringify({ entries: [listed("1.0.0", { sha256: "nope" })] }),
      github,
      baseCommit: BASE,
      tmpRoot: tmpDir,
    });

    expect(result.errors).toEqual([expect.stringMatching(/doesn't parse, so nothing is proposed/)]);
    expect(github.listReleases).not.toHaveBeenCalled();
  });

  it("leaves no download behind", async () => {
    const github = new FakeGitHub();
    github.releases.set("acme/widget-plugin", [
      release("v1.2.0", [["widget-1.2.0.dntr", "broken"]]),
      release("v1.1.0", [["acme.widget-1.1.0.dntr", "1.1.0"]]),
    ]);
    const before = await readdir(tmpDir);
    await run(github);
    expect(await readdir(tmpDir)).toEqual(before);
  });
});

describe("RestCatalogGitHub", () => {
  type Call = { method: string; url: string; body?: unknown; headers: Record<string, string> };

  function fakeApi(routes: Array<[match: string, respond: () => Response]>) {
    const calls: Call[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: init?.headers as Record<string, string>,
      });
      const route = routes.find(([match]) => `${method} ${url}`.startsWith(match));
      return route
        ? route[1]()
        : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    });
    return { calls, fetch };
  }

  const json =
    (data: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(data), { status });
  const API = "https://api.github.com/repos/daintreehq/daintree";
  const request: OpenPullRequestRequest = {
    branch: "plugin-catalog/acme.widget-1.1.0",
    base: "develop",
    baseSha: BASE.sha,
    path: CATALOG_FILE,
    blobSha: BASE.blobSha,
    content: '{ "entries": [] }\n',
    title: "chore(catalog): add acme.widget 1.1.0",
    body: "body",
    labels: [LABELS.catalog, LABELS.quickMerge],
  };
  const pr = {
    number: 9,
    html_url: "https://github.com/daintreehq/daintree/pull/9",
    state: "open",
  };

  it("creates the branch, commits the catalog, opens the pull request and labels it", async () => {
    const { calls, fetch } = fakeApi([
      [`POST ${API}/git/refs`, json({}, 201)],
      [`PUT ${API}/contents/plugins/catalog.json`, json({}, 200)],
      [`POST ${API}/pulls`, json(pr, 201)],
      [`POST ${API}/issues/9/labels`, json([], 200)],
    ]);
    const opened = await new RestCatalogGitHub("daintreehq/daintree", "tok", fetch).openPullRequest(
      request
    );

    expect(opened).toEqual(pr);
    expect(calls.map((c) => `${c.method} ${c.url.replace(API, "")}`)).toEqual([
      "POST /git/refs",
      "PUT /contents/plugins/catalog.json",
      "POST /pulls",
      "POST /issues/9/labels",
    ]);
    expect(calls[0].body).toEqual({ ref: `refs/heads/${request.branch}`, sha: BASE.sha });
    const put = calls[1].body as { content: string; sha: string; branch: string };
    expect(Buffer.from(put.content, "base64").toString("utf8")).toBe(request.content);
    expect(put).toMatchObject({ sha: BASE.blobSha, branch: request.branch });
    expect(calls[2].body).toEqual({
      title: request.title,
      head: request.branch,
      base: "develop",
      body: "body",
    });
    expect(calls[3].body).toEqual({ labels: request.labels });
    expect(calls.every((c) => c.headers.authorization === "Bearer tok")).toBe(true);
  });

  it("reuses a leftover branch that changes nothing but the catalog", async () => {
    const { calls, fetch } = fakeApi([
      [`POST ${API}/git/refs`, json({ message: "Reference already exists" }, 422)],
      [`GET ${API}/compare/`, json({ ahead_by: 1, files: [{ filename: CATALOG_FILE }] })],
      [`PATCH ${API}/git/refs/heads/plugin-catalog/acme.widget-1.1.0`, json({})],
      [`PUT ${API}/contents/`, json({})],
      [`POST ${API}/pulls`, json(pr, 201)],
      [`POST ${API}/issues/9/labels`, json([])],
    ]);
    await new RestCatalogGitHub("daintreehq/daintree", "tok", fetch).openPullRequest(request);

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ sha: BASE.sha, force: true });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBe(true);
  });

  it("leaves alone a branch that someone else changed", async () => {
    const { calls, fetch } = fakeApi([
      [`POST ${API}/git/refs`, json({ message: "Reference already exists" }, 422)],
      [`GET ${API}/compare/`, json({ ahead_by: 1, files: [{ filename: "src/app.ts" }] })],
    ]);
    await expect(
      new RestCatalogGitHub("daintreehq/daintree", "tok", fetch).openPullRequest(request)
    ).rejects.toThrow(/already exists with other changes/);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("leaves alone a catalog-only branch with more than one commit", async () => {
    const { calls, fetch } = fakeApi([
      [`POST ${API}/git/refs`, json({ message: "Reference already exists" }, 422)],
      [`GET ${API}/compare/`, json({ ahead_by: 2, files: [{ filename: CATALOG_FILE }] })],
    ]);
    await expect(
      new RestCatalogGitHub("daintreehq/daintree", "tok", fetch).openPullRequest(request)
    ).rejects.toThrow(/already exists with other changes/);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("still reports the pull request when its labels can't be added", async () => {
    const { fetch } = fakeApi([
      [`POST ${API}/git/refs`, json({}, 201)],
      [`PUT ${API}/contents/`, json({})],
      [`POST ${API}/pulls`, json(pr, 201)],
      [`POST ${API}/issues/9/labels`, json({ message: "Resource not accessible" }, 403)],
    ]);
    const opened = await new RestCatalogGitHub("daintreehq/daintree", "tok", fetch).openPullRequest(
      request
    );
    expect(opened.number).toBe(9);
    expect(opened.labelError).toMatch(/HTTP 403: Resource not accessible/);
  });

  it("reads a catalog raw at a ref, and a missing one as none", async () => {
    const { calls, fetch } = fakeApi([
      [
        `GET ${API}/contents/plugins/catalog.json?ref=refs%2Fpull%2F7%2Fhead`,
        () => new Response("{}"),
      ],
    ]);
    const github = new RestCatalogGitHub("daintreehq/daintree", undefined, fetch);
    expect(await github.catalogAt("refs/pull/7/head")).toBe("{}");
    expect(await github.catalogAt("refs/pull/8/head")).toBeUndefined();
    expect(calls[0].headers.accept).toBe("application/vnd.github.raw+json");
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it("pages through open pull requests and finds a branch's in any state", async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...pr, number: n * 1000 + i }));
    const { calls, fetch } = fakeApi([
      [`GET ${API}/pulls?state=open&base=develop&per_page=100&page=1`, json(page(1, 100))],
      [`GET ${API}/pulls?state=open&base=develop&per_page=100&page=2`, json(page(2, 3))],
      [`GET ${API}/pulls?state=all`, json([pr])],
    ]);
    const github = new RestCatalogGitHub("daintreehq/daintree", "tok", fetch);
    expect(await github.openPullRequests("develop")).toHaveLength(103);
    expect(await github.pullRequestsFor("plugin-catalog/acme.widget-1.1.0")).toEqual([pr]);
    expect(calls.at(-1)?.url).toContain("head=daintreehq%3Aplugin-catalog%2Facme.widget-1.1.0");
  });

  it("reads a repository's releases past the first page", async () => {
    const releases = (count: number, tag: string) =>
      Array.from({ length: count }, () => release(tag, []));
    const route = "https://api.github.com/repos/acme/widget-plugin/releases?per_page=100";
    const { fetch } = fakeApi([
      [`GET ${route}&page=1`, json(releases(100, "v2.0.0-rc"))],
      [`GET ${route}&page=2`, json(releases(1, "v1.1.0"))],
    ]);
    const found = await new RestCatalogGitHub("daintreehq/daintree", "tok", fetch).listReleases(
      "acme",
      "widget-plugin"
    );
    expect(found).toHaveLength(101);
    expect(found.at(-1)?.tag_name).toBe("v1.1.0");
  });
});

describe("runMode", () => {
  it("opens pull requests only with the bot token, and reads with any token", () => {
    expect(runMode(false, { PLUGIN_CATALOG_BOT_TOKEN: "bot", GITHUB_TOKEN: "gh" })).toEqual({
      dryRun: false,
      token: "bot",
    });
    const fallback = runMode(false, { GITHUB_TOKEN: "gh" });
    expect(fallback).toMatchObject({ dryRun: true, token: "gh" });
    expect(fallback.notice).toMatch(/PLUGIN_CATALOG_BOT_TOKEN isn't set/);
    expect(runMode(true, { PLUGIN_CATALOG_BOT_TOKEN: "bot" })).toEqual({
      dryRun: true,
      token: "bot",
    });
  });
});
