import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRevisionSchema } from "../../../../shared/elementPicker/resolution.js";
import type { ResolveBudget } from "../../../../shared/elementPicker/resolver.js";
import {
  JobSourceAccess,
  containSourcePath,
  readBoundedSource,
  revisionOf,
  type JobSourceAccessOptions,
  type ServedSourceMap,
  type SourceMapProvider,
  type SourceRoots,
} from "../sourceAccess.js";

let root: string;
let roots: SourceRoots;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picker-source-")));
  fs.mkdirSync(path.join(root, "app", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "outside"));
  fs.writeFileSync(path.join(root, "app", "src", "A.svelte"), "a");
  fs.writeFileSync(path.join(root, "app", "src", "B.svelte"), "b");
  fs.writeFileSync(path.join(root, "outside", "secret.txt"), "secret");
  roots = { worktreePath: root, appRoot: path.join(root, "app") };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("containSourcePath", () => {
  it("resolves a ref inside the app to its real path", async () => {
    await expect(containSourcePath(roots, "app/src/A.svelte")).resolves.toEqual({
      ok: true,
      absolute: path.join(root, "app", "src", "A.svelte"),
    });
  });

  it("refuses a ref outside the app before touching the disk", async () => {
    const realpath = vi.spyOn(fs.promises, "realpath");
    await expect(containSourcePath(roots, "outside/secret.txt")).resolves.toEqual({
      ok: false,
      reason: "outside-workspace",
    });
    // The app root itself is not a file inside it.
    await expect(containSourcePath(roots, "app")).resolves.toMatchObject({ ok: false });
    expect(realpath).not.toHaveBeenCalled();
    realpath.mockRestore();
  });

  it("refuses a symlink inside the app that leads out of it", async () => {
    fs.symlinkSync(path.join(root, "outside", "secret.txt"), path.join(root, "app", "src", "link"));
    await expect(containSourcePath(roots, "app/src/link")).resolves.toEqual({
      ok: false,
      reason: "outside-workspace",
    });
  });

  it("accepts a directory whose name merely starts with two dots", async () => {
    fs.mkdirSync(path.join(root, "app", "..generated"));
    fs.writeFileSync(path.join(root, "app", "..generated", "G.svelte"), "g");
    await expect(containSourcePath(roots, "app/..generated/G.svelte")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("reports a missing file, and refuses control characters", async () => {
    await expect(containSourcePath(roots, "app/src/Gone.svelte")).resolves.toEqual({
      ok: false,
      reason: "file-missing",
    });
    await expect(containSourcePath(roots, "app/src/A\u0007.svelte")).resolves.toEqual({
      ok: false,
      reason: "outside-workspace",
    });
  });
});

describe("readBoundedSource", () => {
  it("reads a file at exactly the limit and refuses one a byte past it", async () => {
    const file = path.join(root, "app", "src", "Sized.svelte");
    fs.writeFileSync(file, "x".repeat(64));
    const exact = await readBoundedSource(file, 64);
    expect(exact.status === "ok" && exact.bytes.byteLength).toBe(64);
    await expect(readBoundedSource(file, 63)).resolves.toEqual({ status: "too-large" });
  });

  it("returns bytes with a backing store of their own", async () => {
    const read = await readBoundedSource(path.join(root, "app", "src", "A.svelte"), 1024);
    expect(read.status === "ok" && read.bytes.buffer.byteLength).toBe(1);
  });

  it("treats a directory and a symlink leaf as no source", async () => {
    await expect(readBoundedSource(path.join(root, "app", "src"), 1024)).resolves.toEqual({
      status: "missing",
    });
    const link = path.join(root, "app", "src", "leaf");
    fs.symlinkSync(path.join(root, "app", "src", "A.svelte"), link);
    await expect(readBoundedSource(link, 1024)).resolves.toEqual({ status: "missing" });
  });

  it("rethrows a cancelled read rather than reporting the file missing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readBoundedSource(path.join(root, "app", "src", "A.svelte"), 1024, controller.signal)
    ).rejects.toThrow();
  });
});

describe("revisionOf", () => {
  it("is a contract revision that tells same-size contents apart", () => {
    const one = revisionOf(new TextEncoder().encode("abc"));
    expect(FileRevisionSchema.safeParse(one).success).toBe(true);
    expect(revisionOf(new TextEncoder().encode("abc"))).toBe(one);
    expect(revisionOf(new TextEncoder().encode("abd"))).not.toBe(one);
  });
});

const fullBudget: ResolveBudget = {
  maxFiles: 32,
  maxFileBytes: 1024 * 1024,
  maxNetworkRequests: 8,
  maxNetworkBytes: 4 * 1024 * 1024,
  deadlineMs: 5_000,
};

function access(overrides: Partial<JobSourceAccessOptions> = {}) {
  const controller = new AbortController();
  const onRead = vi.fn();
  const options: JobSourceAccessOptions = {
    workspaceId: "ws",
    roots,
    budget: fullBudget,
    signal: controller.signal,
    expired: () => false,
    previewOrigin: "http://localhost:5173",
    sourceMaps: async () => ({ ok: false, reason: "unsupported" }),
    onRead,
    ...overrides,
  };
  return { access: new JobSourceAccess(options), controller, onRead };
}

const ref = (p: string, workspaceId = "ws") => ({ workspaceId, path: p });

describe("JobSourceAccess", () => {
  it("serves bytes and their revision, and reports the read for tracking", async () => {
    const { access: job, onRead } = access();
    const read = await job.readSource(ref("app/src/A.svelte"));
    expect(read.ok && new TextDecoder().decode(read.value.bytes)).toBe("a");
    expect(read.ok && read.value.revision).toBe(revisionOf(new TextEncoder().encode("a")));
    expect(onRead).toHaveBeenCalledWith(
      path.join(root, "app", "src", "A.svelte"),
      ref("app/src/A.svelte"),
      read.ok ? read.value.revision : null
    );
  });

  it("charges distinct files against maxFiles and serves repeats from the first read", async () => {
    const { access: job } = access({ budget: { ...fullBudget, maxFiles: 1 } });
    const first = await job.readSource(ref("app/src/A.svelte"));
    fs.writeFileSync(path.join(root, "app", "src", "A.svelte"), "changed");
    await expect(job.readSource(ref("app/src/A.svelte"))).resolves.toEqual(first);
    await expect(job.readSource(ref("app/src/B.svelte"))).resolves.toEqual({
      ok: false,
      reason: "budget-exhausted",
    });
  });

  it("charges a failed read too", async () => {
    const { access: job } = access({ budget: { ...fullBudget, maxFiles: 1 } });
    await expect(job.readSource(ref("app/src/Gone.svelte"))).resolves.toMatchObject({
      reason: "file-missing",
    });
    await expect(job.readSource(ref("app/src/A.svelte"))).resolves.toMatchObject({
      reason: "budget-exhausted",
    });
  });

  it("holds a file to the request's own byte limit", async () => {
    fs.writeFileSync(path.join(root, "app", "src", "Big.svelte"), "x".repeat(10));
    const { access: job } = access({ budget: { ...fullBudget, maxFileBytes: 9 } });
    await expect(job.readSource(ref("app/src/Big.svelte"))).resolves.toEqual({
      ok: false,
      reason: "budget-exhausted",
    });
  });

  it("refuses a ref from another workspace or with a traversal", async () => {
    const { access: job } = access();
    await expect(job.readSource(ref("app/src/A.svelte", "other"))).resolves.toMatchObject({
      reason: "outside-workspace",
    });
    await expect(job.readSource(ref("app/../outside/secret.txt"))).resolves.toMatchObject({
      reason: "outside-workspace",
    });
    await expect(job.readSource("app/src/A.svelte")).resolves.toMatchObject({
      reason: "outside-workspace",
    });
  });

  it("reports cancelled, or budget-exhausted once the deadline is what stopped it", async () => {
    const cancelled = access();
    cancelled.controller.abort();
    await expect(cancelled.access.readSource(ref("app/src/A.svelte"))).resolves.toEqual({
      ok: false,
      reason: "cancelled",
    });
    const expired = access({ expired: () => true });
    expired.controller.abort();
    await expect(expired.access.fetchSourceMap("http://localhost/a.js")).resolves.toEqual({
      ok: false,
      reason: "budget-exhausted",
    });
  });

  it("remembers the revision it served for each path, and only those", async () => {
    const { access: job } = access();
    const read = await job.readSource(ref("app/src/A.svelte"));
    expect(job.servedRevision("app/src/A.svelte")).toBe(read.ok ? read.value.revision : "none");
    expect(job.servedRevision("app/src/B.svelte")).toBeUndefined();
  });

  it("runs source-map fetches one at a time, each charged as it spends", async () => {
    const releases: Array<() => void> = [];
    const sourceMaps = vi.fn<SourceMapProvider>(
      ({ generatedUrl, allowance }) =>
        new Promise((resolve) =>
          releases.push(() => {
            allowance.request();
            resolve(
              allowance.bytes(6) ? served(generatedUrl) : { ok: false, reason: "budget-exhausted" }
            );
          })
        )
    );
    const { access: job } = access({ sourceMaps, budget: { ...fullBudget, maxNetworkBytes: 8 } });
    const first = job.fetchSourceMap("http://localhost:5173/a.js");
    const second = job.fetchSourceMap("http://localhost:5173/b.js");
    await vi.waitFor(() => expect(sourceMaps).toHaveBeenCalledTimes(1));
    releases[0]!();
    await expect(first).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(sourceMaps).toHaveBeenCalledTimes(2));
    releases[1]!();
    await expect(second).resolves.toEqual({ ok: false, reason: "budget-exhausted" });
    // Nothing is left, so a third never reaches the provider.
    await expect(job.fetchSourceMap("http://localhost:5173/c.js")).resolves.toEqual({
      ok: false,
      reason: "budget-exhausted",
    });
    expect(sourceMaps).toHaveBeenCalledTimes(2);
  });

  it("charges every request a provider makes, and refuses one past the limit", async () => {
    const spent: boolean[] = [];
    const sourceMaps = vi.fn<SourceMapProvider>(async ({ generatedUrl, allowance }) => {
      spent.push(allowance.request(), allowance.request());
      return served(generatedUrl);
    });
    const { access: job } = access({
      sourceMaps,
      budget: { ...fullBudget, maxNetworkRequests: 3 },
    });
    await job.fetchSourceMap("http://localhost:5173/a.js");
    await job.fetchSourceMap("http://localhost:5173/b.js");
    expect(spent).toEqual([true, true, true, false]);
    await expect(job.fetchSourceMap("http://localhost:5173/c.js")).resolves.toEqual({
      ok: false,
      reason: "budget-exhausted",
    });
    expect(sourceMaps).toHaveBeenCalledTimes(2);
  });

  it("never calls the provider once no network bytes are left", async () => {
    const sourceMaps = vi.fn();
    const { access: job } = access({ sourceMaps, budget: { ...fullBudget, maxNetworkBytes: 0 } });
    await expect(job.fetchSourceMap("http://localhost:5173/a.js")).resolves.toEqual({
      ok: false,
      reason: "budget-exhausted",
    });
    expect(sourceMaps).not.toHaveBeenCalled();
  });

  it("fetches nothing for a workspace registered with no preview origin", async () => {
    const sourceMaps = vi.fn();
    const { access: job } = access({ sourceMaps, previewOrigin: null });
    await expect(job.fetchSourceMap("http://localhost:5173/a.js")).resolves.toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(sourceMaps).not.toHaveBeenCalled();
  });

  it("hands the provider the workspace's origin, and fetches each module once per job", async () => {
    const sourceMaps = vi.fn<SourceMapProvider>(async ({ generatedUrl }) => served(generatedUrl));
    const { access: job } = access({ sourceMaps });
    const first = await job.fetchSourceMap("http://localhost:5173/a.js");
    await expect(job.fetchSourceMap("http://localhost:5173/a.js")).resolves.toEqual(first);
    // The base stays in main: the host is told the map, not what it resolves against.
    expect(first.ok && Object.keys(first.value).sort()).toEqual(["revision", "text", "url"]);
    expect(sourceMaps).toHaveBeenCalledTimes(1);
    expect(sourceMaps).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws",
        previewOrigin: "http://localhost:5173",
        generatedUrl: "http://localhost:5173/a.js",
      }),
      expect.anything()
    );
  });

  it("remembers which maps it served, by URL and revision", async () => {
    const sourceMaps = vi.fn<SourceMapProvider>(async ({ generatedUrl }) =>
      served(generatedUrl, "http://localhost:5173/a.js.map")
    );
    const { access: job } = access({ sourceMaps });
    const result = await job.fetchSourceMap("http://localhost:5173/a.js");
    const revision = result.ok ? result.value.revision : revisionOf(new Uint8Array());
    expect(job.servedMap("http://localhost:5173/a.js.map", revision)).toBe(true);
    expect(job.servedMap(null, revision)).toBe(false);
    expect(job.servedMap("http://localhost:5173/a.js.map", revisionOf(new Uint8Array([1])))).toBe(
      false
    );
  });

  it("locates a source against the base of a map this job served, and nothing else", async () => {
    const sourceMaps = vi.fn<SourceMapProvider>(async ({ generatedUrl }) => served(generatedUrl));
    const { access: job } = access({ sourceMaps });
    await expect(
      job.locateSource("http://localhost:5173/src/A.svelte", "A.svelte", null)
    ).resolves.toEqual({ ok: false, reason: "map-missing" });
    await job.fetchSourceMap("http://localhost:5173/src/A.svelte?t=1");
    await expect(
      job.locateSource("http://localhost:5173/src/A.svelte?t=1", "A.svelte", null)
    ).resolves.toEqual({ ok: true, value: ref("app/src/A.svelte") });
    const outside = `/@fs${path.join(root, "outside", "secret.txt")}`;
    await expect(
      job.locateSource("http://localhost:5173/src/A.svelte?t=1", outside, null)
    ).resolves.toEqual({ ok: false, reason: "outside-workspace" });
  });

  it("locates nothing through a map that failed to fetch", async () => {
    const { access: job } = access({
      sourceMaps: async () => ({ ok: false, reason: "map-missing" }),
    });
    await job.fetchSourceMap("http://localhost:5173/src/A.svelte");
    await expect(
      job.locateSource("http://localhost:5173/src/A.svelte", "A.svelte", null)
    ).resolves.toEqual({ ok: false, reason: "map-missing" });
  });
});

function served(
  generatedUrl: string,
  url: string | null = null
): { ok: true; value: ServedSourceMap } {
  const text = JSON.stringify({ version: 3, sources: [], mappings: "" });
  return {
    ok: true,
    value: {
      url,
      base: url ?? generatedUrl,
      revision: revisionOf(new TextEncoder().encode(text)),
      text,
    },
  };
}
