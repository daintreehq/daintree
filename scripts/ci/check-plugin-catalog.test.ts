import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packPluginArchive } from "../../electron/services/PluginArchive.js";
import type { PluginCatalogEntry } from "../../electron/services/plugin/pluginCatalogSchema.js";
import { MAX_DNTR_BYTES } from "../../electron/utils/pluginArchiveConstants.js";
import {
  changedEntries,
  checkCatalog,
  checkEntry,
  entriesNeedingPerson,
  escapeAnnotation,
} from "./check-plugin-catalog.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = "https://github.com/acme/widget-plugin";
const assetUrl = (version: string, repo = REPO) =>
  `${repo}/releases/download/v${version}/acme.widget-${version}.dntr`;

let tmpDir: string;
const archives = new Map<string, Buffer>();

async function pack(name: string, manifest: Record<string, unknown>): Promise<Buffer> {
  const src = path.join(tmpDir, name);
  await mkdir(path.join(src, "dist"), { recursive: true });
  await writeFile(path.join(src, "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(src, "dist", "index.js"), "export {};\n");
  const out = path.join(tmpDir, `${name}.dntr`);
  await packPluginArchive(src, out);
  return readFile(out);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function entry(version: string, overrides: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry {
  const bytes = archives.get(version);
  return {
    id: "acme.widget",
    repo: REPO,
    version,
    url: assetUrl(version),
    sha256: bytes ? sha256(bytes) : "0".repeat(64),
    capabilities: ["fs:user-data-read", "mcp:expose"],
    ...overrides,
  };
}

/** Serves each fixture archive at its version's asset URL. */
function servingFetch(routes: Record<string, () => Response> = {}) {
  return vi.fn(async (url: string) => {
    const route = routes[url];
    if (route) return route();
    const version = /download\/v([^/]+)\//.exec(url)?.[1];
    const bytes = version ? archives.get(version) : undefined;
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("missing", { status: 404 });
  });
}

const noSleep = () => Promise.resolve();

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "check-plugin-catalog-test-"));
  const capabilities = ["fs:user-data-read", "mcp:expose"];
  archives.set("1.0.0", await pack("v1", { name: "acme.widget", version: "1.0.0", capabilities }));
  archives.set("1.1.0", await pack("v11", { name: "acme.widget", version: "1.1.0", capabilities }));
  archives.set(
    "2.0.0",
    await pack("other", { name: "acme.other", version: "2.0.0", capabilities })
  );
  archives.set("3.0.0", await pack("v3", { name: "acme.widget", version: "3.0.1", capabilities }));
  archives.set("4.0.0", Buffer.from("not a zip archive"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("changedEntries", () => {
  it("returns entries the base doesn't list or lists differently, in head order", () => {
    const kept = entry("1.0.0");
    const edited = entry("1.1.0");
    const base = [kept, { ...edited, capabilities: ["mcp:expose"] }, entry("0.9.0")];
    const added = entry("2.0.0");
    expect(changedEntries(base, [added, edited, kept])).toEqual([added, edited]);
  });

  it("ignores reordering and removals", () => {
    const base = [entry("1.0.0"), entry("1.1.0")];
    expect(changedEntries(base, [base[1], base[0]])).toEqual([]);
    expect(changedEntries(base, [base[1]])).toEqual([]);
  });
});

describe("entriesNeedingPerson", () => {
  const capsUpdate = (version: string, capabilities: string[]) => entry(version, { capabilities });

  it("names a first listing and nothing else for it", () => {
    expect(entriesNeedingPerson([], [entry("1.0.0")])).toEqual([
      { entry: "acme.widget@1.0.0", reason: "first listing" },
    ]);
  });

  it("lets a new release with the same repository and capabilities through", () => {
    const repoInOtherCase = REPO.replace("acme/widget-plugin", "Acme/Widget-Plugin");
    expect(
      entriesNeedingPerson([entry("1.0.0")], [entry("1.1.0", { repo: repoInOtherCase })])
    ).toEqual([]);
  });

  it("compares against the newest earlier release by semver, not file order", () => {
    const base = [capsUpdate("1.10.0", ["mcp:expose"]), capsUpdate("1.9.0", ["fs:user-data-read"])];
    expect(entriesNeedingPerson(base, [capsUpdate("1.11.0", ["mcp:expose"])])).toEqual([]);
    expect(entriesNeedingPerson(base, [capsUpdate("1.11.0", ["fs:user-data-read"])])).toEqual([
      { entry: "acme.widget@1.11.0", reason: "new capabilities since 1.10.0: fs:user-data-read" },
    ]);
  });

  it("names a repository change, including a move back to an older one", () => {
    const moved = "https://github.com/acme-labs/widget";
    const base = [entry("1.0.0"), entry("1.1.0", { repo: moved, url: assetUrl("1.1.0", moved) })];
    const notes = entriesNeedingPerson(base, [entry("1.2.0")]);
    expect(notes).toEqual([
      {
        entry: "acme.widget@1.2.0",
        reason: `repository changed from ${moved} (1.1.0) to ${REPO}`,
      },
    ]);
  });

  it("names a listed release that changed in place", () => {
    const notes = entriesNeedingPerson(
      [entry("1.0.0")],
      [entry("1.0.0", { sha256: "f".repeat(64) })]
    );
    expect(notes).toEqual([
      { entry: "acme.widget@1.0.0", reason: "an already-listed release changed" },
    ]);
  });
});

describe("checkCatalog", () => {
  it("passes an added entry whose asset matches its listing", async () => {
    const fetch = servingFetch();
    const result = await checkCatalog({ entries: [entry("1.0.0")] }, { entries: [] }, { fetch });
    expect(result.errors).toEqual([]);
    expect(result.checked).toEqual(["acme.widget@1.0.0"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("downloads only what changed, and nothing for a removal", async () => {
    const fetch = servingFetch();
    const base = { entries: [entry("1.0.0"), entry("1.1.0")] };
    expect((await checkCatalog({ entries: [entry("1.0.0")] }, base, { fetch })).checked).toEqual(
      []
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("downloads a listed release again when its listing changed in place", async () => {
    const real = entry("1.0.0");
    const unchanged = entry("1.1.0");
    const stale = { ...real, sha256: "a".repeat(64) };

    const fetch = servingFetch();
    const repaired = await checkCatalog(
      { entries: [real, unchanged] },
      { entries: [stale, unchanged] },
      { fetch }
    );
    expect(repaired.errors).toEqual([]);
    expect(repaired.checked).toEqual(["acme.widget@1.0.0"]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([assetUrl("1.0.0")]);

    const swapped = await checkCatalog(
      { entries: [stale, unchanged] },
      { entries: [real, unchanged] },
      { fetch: servingFetch() }
    );
    expect(swapped.errors).toHaveLength(1);
    expect(swapped.errors[0]).toMatch(/^acme\.widget@1\.0\.0: the asset's SHA-256 is /);
  });

  it("downloads every entry when there is no base", async () => {
    const fetch = servingFetch();
    const result = await checkCatalog({ entries: [entry("1.0.0"), entry("1.1.0")] }, undefined, {
      fetch,
    });
    expect(result.errors).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails a digest mismatch and stops there", async () => {
    const listed = entry("1.0.0", { sha256: "a".repeat(64), capabilities: [] });
    const { errors } = await checkCatalog({ entries: [listed] }, undefined, {
      fetch: servingFetch(),
    });
    expect(errors).toEqual([
      `acme.widget@1.0.0: the asset's SHA-256 is ${sha256(archives.get("1.0.0")!)}, not the listed ${"a".repeat(64)}`,
    ]);
  });

  it("fails an archive whose manifest names another plugin or version", async () => {
    const { errors } = await checkCatalog(
      { entries: [entry("2.0.0"), entry("3.0.0")] },
      undefined,
      { fetch: servingFetch() }
    );
    expect(errors).toEqual([
      'acme.widget@2.0.0: the archive\'s manifest.name is "acme.other", not "acme.widget"',
      'acme.widget@3.0.0: the archive\'s manifest.version is "3.0.1", not "3.0.0"',
    ]);
  });

  it("requires the manifest's capabilities in the manifest's order", async () => {
    const reordered = entry("1.0.0", { capabilities: ["mcp:expose", "fs:user-data-read"] });
    const missing = entry("1.1.0", { capabilities: ["mcp:expose"] });
    const { errors } = await checkCatalog({ entries: [reordered, missing] }, undefined, {
      fetch: servingFetch(),
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^acme\.widget@1\.0\.0: capabilities must be the manifest's list/);
    expect(errors[1]).toMatch(/^acme\.widget@1\.1\.0: capabilities must be the manifest's list/);
  });

  it("fails an asset that isn't an installable archive", async () => {
    const { errors } = await checkCatalog({ entries: [entry("4.0.0")] }, undefined, {
      fetch: servingFetch(),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^acme\.widget@4\.0\.0: the asset isn't an installable \.dntr: /);
  });

  it("refuses a catalog the client would refuse, before downloading anything", async () => {
    const fetch = servingFetch();
    const latest = entry("1.0.0", { url: `${REPO}/releases/latest/download/acme.widget.dntr` });
    const duplicated = { entries: [entry("1.0.0"), entry("1.0.0")] };
    const otherRepo = entry("1.0.0", { url: assetUrl("1.0.0", "https://github.com/evil/widget") });
    for (const head of [{ entries: [latest] }, duplicated, { entries: [otherRepo] }]) {
      const result = await checkCatalog(head, undefined, { fetch });
      expect(result.errors).toHaveLength(1);
      expect(result.checked).toEqual([]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks every entry, with a warning, when the base doesn't parse", async () => {
    const fetch = servingFetch();
    const result = await checkCatalog(
      { entries: [entry("1.0.0")] },
      { entries: "nope" },
      { fetch }
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.checked).toEqual(["acme.widget@1.0.0"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails an HTTP error without retrying it", async () => {
    const fetch = servingFetch({ [assetUrl("1.0.0")]: () => new Response("", { status: 404 }) });
    const { errors } = await checkCatalog({ entries: [entry("1.0.0")] }, undefined, {
      fetch,
      sleep: noSleep,
    });
    expect(errors).toEqual([
      `acme.widget@1.0.0: ${assetUrl("1.0.0")}: download failed with HTTP 404`,
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a 503, a 429 and a network failure, then passes", async () => {
    const bytes = archives.get("1.0.0")!;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const { errors } = await checkCatalog({ entries: [entry("1.0.0")] }, undefined, {
      fetch,
      sleep,
      attempts: 4,
    });
    expect(errors).toEqual([]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 4000, 8000]);
  });

  it("gives up after the last attempt", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { errors } = await checkCatalog({ entries: [entry("1.0.0")] }, undefined, {
      fetch,
      sleep: noSleep,
    });
    expect(errors).toEqual([`acme.widget@1.0.0: ${assetUrl("1.0.0")}: fetch failed`]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("times out a download that never answers", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        })
    );
    const { errors } = await checkCatalog({ entries: [entry("1.0.0")] }, undefined, {
      fetch,
      timeoutMs: 20,
      attempts: 1,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/timeout|aborted/i);
  });

  it("times out a download whose body stalls after its headers", async () => {
    const stalled = () =>
      new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }));
    const fetch = servingFetch({ [assetUrl("1.0.0")]: stalled });
    const { errors } = await checkCatalog({ entries: [entry("1.0.0")] }, undefined, {
      fetch,
      timeoutMs: 20,
      attempts: 1,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/: timed out: /);
  });

  it("refuses an asset over the installer's size cap, declared, streamed or misdeclared", async () => {
    const declared = () =>
      new Response("x", { headers: { "content-length": String(MAX_DNTR_BYTES + 1) } });
    const chunk = new Uint8Array(1024 * 1024);
    const oversizedStream = () => {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += chunk.byteLength;
          controller.enqueue(chunk);
          if (sent > MAX_DNTR_BYTES + chunk.byteLength) controller.close();
        },
      });
    };
    const streamed = () => new Response(oversizedStream());
    const misdeclared = () =>
      new Response(oversizedStream(), { headers: { "content-length": "1" } });
    const fetch = servingFetch({
      [assetUrl("1.0.0")]: declared,
      [assetUrl("1.1.0")]: streamed,
      [assetUrl("2.0.0")]: misdeclared,
    });
    const { errors } = await checkCatalog(
      { entries: [entry("1.0.0"), entry("1.1.0"), entry("2.0.0")] },
      undefined,
      { fetch, sleep: noSleep }
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/over the \d+ byte limit$/);
    expect(errors[1]).toMatch(/exceeds the \d+ byte limit$/);
    expect(errors[2]).toMatch(/exceeds the \d+ byte limit$/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("leaves no download behind", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpDir, "root-"));
    await checkCatalog({ entries: [entry("1.0.0"), entry("4.0.0")] }, undefined, {
      fetch: servingFetch(),
      tmpRoot,
    });
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});

describe("checkEntry", () => {
  it("removes its download whether the entry passes, fails, or never arrives", async () => {
    const workDir = await mkdtemp(path.join(tmpDir, "work-"));
    const fetch = servingFetch({ [assetUrl("1.1.0")]: () => new Response("", { status: 404 }) });
    const mismatched = entry("2.0.0", { sha256: "b".repeat(64) });
    for (const listed of [entry("1.0.0"), mismatched, entry("1.1.0")]) {
      await checkEntry(listed, workDir, { fetch, sleep: noSleep });
      expect(await readdir(workDir), listed.version).toEqual([]);
    }
  });
});

describe("escapeAnnotation", () => {
  it("keeps a message on one workflow-command line", () => {
    expect(escapeAnnotation("50% done\r\n::error::x")).toBe("50%25 done%0D%0A::error::x");
  });
});

describe("command line", () => {
  const script = path.join(repoRoot, "scripts/ci/check-plugin-catalog.ts");
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  let gitDir: string;

  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [tsxCli, script, ...args], {
      cwd: gitDir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    expect(result.error).toBeUndefined();
    return result;
  };

  beforeAll(async () => {
    gitDir = await mkdtemp(path.join(os.tmpdir(), "check-plugin-catalog-git-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: gitDir, stdio: "ignore" });
    const commit = (message: string) =>
      git(
        "-c",
        "user.email=ci@example.test",
        "-c",
        "user.name=CI",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        message
      );
    git("init", "-q");
    commit("no catalog");
    git("tag", "no-catalog");
    await mkdir(path.join(gitDir, "plugins"));
    await writeFile(path.join(gitDir, "plugins/catalog.json"), '{ "entries": ');
    git("add", "plugins/catalog.json");
    commit("broken catalog");
    git("tag", "broken-catalog");
    await writeFile(path.join(gitDir, "plugins/catalog.json"), '{ "entries": [] }\n');
  });

  afterAll(async () => {
    await rm(gitDir, { recursive: true, force: true });
  });

  it("treats a base commit without a catalog as an empty one", () => {
    const result = run("--base", "no-catalog");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("plugins/catalog.json passed, 0 added or changed");
  });

  it("lets a pull request repair a base catalog that isn't JSON, with a warning", () => {
    const result = run("--base", "broken-catalog");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^::warning file=plugins\/catalog\.json::the base catalog doesn't parse/m
    );
  });

  it("fails when the base commit can't be read", () => {
    const result = run("--base", "no-such-ref");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^::error::git show no-such-ref:plugins\/catalog\.json failed/m);
  });
});
