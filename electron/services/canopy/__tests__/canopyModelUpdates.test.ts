import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANOPY_MODEL,
  CanopyModels,
  type CanopyModelFileSpec,
  type CanopyModelRevision,
} from "../canopyModels.js";

const META = JSON.stringify({
  max_len: 1024,
  header_tokens: 192,
  line_tokens: 256,
  question_candidate_rows: 40,
  status_candidate_rows: 60,
  inputs: ["input_ids", "attention_mask", "line_pos", "line_mask", "q_mask", "s_mask"],
  outputs: [
    "category",
    "needs_attention",
    "blocked_on_user",
    "notable",
    "tests",
    "changes",
    "risk",
    "instruction",
    "progress",
    "failure_repeats",
    "score",
    "question_line",
    "status_line",
    "summary_lines",
    "option_lines",
    "action_line",
    "task_line",
  ],
  categories: ["approval", "question", "finished", "error", "working", "running", "idle"],
  classes: {
    tests: ["a"],
    changes: ["a"],
    risk: ["a"],
    instruction: ["a"],
    progress: ["a"],
    failure_repeats: ["a"],
    score: ["a"],
  },
  thresholds: { summary_first: 0.5, summary_more: 0.6, option: 0.5, gate: 0.4, gate_categories: [] },
});
/** A reader a later Daintree needs: a card mode this build doesn't know. */
const FUTURE_META = JSON.stringify({ ...JSON.parse(META), thresholds: { card: "three-line" } });

const blobId = (content: string) => {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

const SHIPPED_REVISION = "a".repeat(40);
const NEWER = "b".repeat(40);
const NEWEST = "c".repeat(40);
const OLDER = "9".repeat(40);
const SHIPPED_AT = Date.parse("2026-10-25T19:08:24.000Z");
const DAY = 86_400_000;

interface Repo {
  sha: string;
  /** When the Hub says it was published. */
  at: number;
  files: Record<string, string>;
  /** Served for a weights file in place of what its published hash describes. */
  servedWeights?: string;
}

function repo(sha: string, at: number, overrides: Partial<Repo> = {}): Repo {
  return {
    sha,
    at,
    files: {
      "config.json": META,
      "reader.json": META,
      "tokenizer.json": `{"model":"${sha}"}`,
      "tokenizer_config.json": "{}",
      "model.int8.onnx": `INT8-${sha}`,
      "model.fp32.onnx": `FP32-${sha}`,
      "README.md": "card",
    },
    ...overrides,
  };
}

const LFS = new Set(["model.int8.onnx", "model.fp32.onnx"]);

/** The pins the Hub publishes for `r`'s reader files, as an update records them. */
function pins(r: Repo): CanopyModelFileSpec[] {
  return ["config.json", "tokenizer.json", "tokenizer_config.json", "model.int8.onnx"].map(
    (name) => {
      const content = r.files[name]!;
      const size = Buffer.byteLength(content);
      return LFS.has(name)
        ? { name, size, sha256: sha256(content) }
        : { name, size, blobId: blobId(content) };
    }
  );
}

/**
 * A fake Hugging Face: the model's detail at its newest revision, and its
 * files at that revision, with Range support. `hold` keeps a file's body back
 * until released.
 */
function hub(r: Repo | null, options: { hold?: string } = {}) {
  const requests: Array<{ url: string; range: string | null }> = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    requests.push({ url, range });
    if (url === `https://huggingface.co/api/models/${CANOPY_MODEL}?blobs=true`) {
      if (!r) return new Response("", { status: 404 });
      return Response.json({
        sha: r.sha,
        lastModified: new Date(r.at).toISOString(),
        private: false,
        siblings: Object.entries(r.files).map(([name, content]) => ({
          rfilename: name,
          size: Buffer.byteLength(content),
          blobId: blobId(content),
          ...(LFS.has(name) ? { lfs: { sha256: sha256(content), size: content.length } } : {}),
        })),
      });
    }
    const file = /^https:\/\/huggingface\.co\/(daintreehq\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(
      url
    );
    if (!file || !r || file[1] !== CANOPY_MODEL || file[2] !== r.sha) {
      return new Response("", { status: 404 });
    }
    const name = file[3]!;
    const content =
      name === "model.int8.onnx" && r.servedWeights !== undefined ? r.servedWeights : r.files[name];
    if (content === undefined) return new Response("", { status: 404 });
    const bytes = Buffer.from(content);
    const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    if (from >= bytes.length && range) return new Response("", { status: 416 });
    const body = bytes.subarray(from);
    if (options.hold === name) {
      // Half the file at once, the rest once released: a download under way.
      const half = Math.floor(body.length / 2);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(body.subarray(0, half));
          await held;
          controller.enqueue(body.subarray(half));
          controller.close();
        },
      });
      return new Response(stream, { status: range ? 206 : 200 });
    }
    return new Response(body, { status: range ? 206 : 200 });
  });
  return { fetchMock, requests, release };
}

const offline = () =>
  vi.fn(async () => {
    throw new TypeError("fetch failed");
  });

let root: string;
let shippedDir: string;
let updates: string;
const SHIPPED_FILES: Record<string, string> = {
  "config.json": META,
  "tokenizer.json": '{"model":"shipped"}',
  "tokenizer_config.json": "{}",
  "model.int8.onnx": "INT8-shipped",
};
const SHIPPED: CanopyModelRevision = {
  revision: SHIPPED_REVISION,
  published: SHIPPED_AT,
  files: pins({ sha: SHIPPED_REVISION, at: SHIPPED_AT, files: SHIPPED_FILES }),
};

function models(changes: () => void = () => {}): CanopyModels {
  return new CanopyModels(shippedDir, changes, { updates, shipped: SHIPPED });
}

/** An update an earlier launch fetched and put in place. */
function installed(r: Repo): string {
  const dir = path.join(updates, r.sha);
  mkdirSync(dir, { recursive: true });
  for (const spec of pins(r)) writeFileSync(path.join(dir, spec.name), r.files[spec.name]!);
  writeFileSync(
    path.join(dir, "install.json"),
    JSON.stringify({ id: CANOPY_MODEL, revision: r.sha, published: r.at, files: pins(r) })
  );
  return dir;
}

const fetchedFiles = (requests: Array<{ url: string }>) =>
  requests.filter((r) => r.url.includes("/resolve/")).map((r) => r.url.split("/").pop());

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "canopy-updates-"));
  shippedDir = path.join(root, "resources", "canopy-reader");
  updates = path.join(root, "userData", "canopy", "reader-updates");
  mkdirSync(shippedDir, { recursive: true });
  for (const [name, content] of Object.entries(SHIPPED_FILES)) {
    writeFileSync(path.join(shippedDir, name), content);
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("CanopyModels, updating the shipped model from Hugging Face", () => {
  it("fetches a newer revision this build reads while the shipped copy reads, checks it, then reads with it", async () => {
    const newer = repo(NEWER, SHIPPED_AT + DAY);
    const { fetchMock, requests, release } = hub(newer, { hold: "model.int8.onnx" });
    vi.stubGlobal("fetch", fetchMock);
    const changes = vi.fn();
    const m = models(changes);

    const ensuring = m.ensure();
    // The shipped copy reads at once, and on through the download.
    expect(await m.installedDir()).toBe(shippedDir);
    await vi.waitFor(() => {
      const state = m.state();
      expect(state?.status === "ready" && state.update?.received).toBeGreaterThan(0);
    });
    const during = m.state();
    expect(during).toMatchObject({
      status: "ready",
      revision: SHIPPED_REVISION,
      source: "bundled",
      update: { revision: NEWER, total: pins(newer).reduce((sum, f) => sum + f.size, 0) },
    });
    expect(m.currentDir()).toBe(shippedDir);

    release();
    await ensuring;
    const dir = path.join(updates, NEWER);
    expect(await m.installedDir()).toBe(dir);
    expect(m.currentDir()).toBe(dir);
    expect(m.state()).toEqual({ id: CANOPY_MODEL, status: "ready", revision: NEWER, source: "update" });
    expect(readFileSync(path.join(dir, "model.int8.onnx"), "utf8")).toBe(`INT8-${NEWER}`);
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).toBe(META);
    // Only what the reader opens, from the revision the Hub named.
    expect(readdirSync(dir).sort()).toEqual([
      "config.json",
      "install.json",
      "model.int8.onnx",
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
    expect(existsSync(`${dir}.download`)).toBe(false);
    expect(requests.every((r) => r.url.startsWith("https://huggingface.co/"))).toBe(true);
    expect(
      requests.filter((r) => r.url.includes("/resolve/")).every((r) => r.url.includes(`/${NEWER}/`))
    ).toBe(true);
    expect(fetchedFiles(requests).filter((name) => name === "config.json")).toHaveLength(1);
    expect(changes).toHaveBeenCalled();

    // The next launch reads it straight away, offline.
    vi.stubGlobal("fetch", offline());
    const next = models();
    await next.ensure();
    expect(await next.installedDir()).toBe(dir);
    expect(next.state()).toMatchObject({ revision: NEWER, source: "update" });
  });

  it("looks through the Hub API and reader.json, never config.json, and fetches nothing when the shipped copy is the newest", async () => {
    const { fetchMock, requests } = hub(repo(SHIPPED_REVISION, SHIPPED_AT));
    vi.stubGlobal("fetch", fetchMock);
    const m = models();
    await m.ensure();

    expect(requests.map((r) => r.url)).toEqual([
      `https://huggingface.co/api/models/${CANOPY_MODEL}?blobs=true`,
    ]);
    expect(await m.installedDir()).toBe(shippedDir);
    expect(m.state()).toEqual({
      id: CANOPY_MODEL,
      status: "ready",
      revision: SHIPPED_REVISION,
      source: "bundled",
    });
    // Asked once a launch.
    await m.ensure();
    expect(requests).toHaveLength(1);
  });

  it("ignores a newer revision this build can't read, reading on with the shipped copy", async () => {
    const future = repo(NEWER, SHIPPED_AT + DAY);
    future.files["reader.json"] = FUTURE_META;
    future.files["config.json"] = FUTURE_META;
    const { fetchMock, requests } = hub(future);
    vi.stubGlobal("fetch", fetchMock);
    const m = models();
    await m.ensure();

    expect(requests.map((r) => r.url)).toEqual([
      `https://huggingface.co/api/models/${CANOPY_MODEL}?blobs=true`,
      `https://huggingface.co/${CANOPY_MODEL}/resolve/${NEWER}/reader.json`,
    ]);
    expect(await m.installedDir()).toBe(shippedDir);
    expect(m.state()).toEqual({
      id: CANOPY_MODEL,
      status: "ready",
      revision: SHIPPED_REVISION,
      source: "bundled",
    });
    expect(existsSync(updates) ? readdirSync(updates) : []).toEqual([]);
  });

  it("reads with the shipped copy offline, says nothing of it, and asks again on the next look", async () => {
    const fetchMock = offline();
    vi.stubGlobal("fetch", fetchMock);
    const m = models();
    await m.ensure();

    expect(await m.installedDir()).toBe(shippedDir);
    expect(m.state()).toEqual({
      id: CANOPY_MODEL,
      status: "ready",
      revision: SHIPPED_REVISION,
      source: "bundled",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Back online: the next look asks again, and the update comes.
    const { fetchMock: online } = hub(repo(NEWER, SHIPPED_AT + DAY));
    vi.stubGlobal("fetch", online);
    await m.ensure();
    expect(await m.installedDir()).toBe(path.join(updates, NEWER));
  });

  it("deletes an update the shipped copy has caught up with after an app update, and reads with the shipped copy", async () => {
    vi.stubGlobal("fetch", offline());
    const stale = installed(repo(OLDER, SHIPPED_AT - DAY));
    // The very revision this build ships, fetched by the build before it.
    const same = installed(repo(SHIPPED_REVISION, SHIPPED_AT));
    const m = models();
    await m.ensure();

    expect(await m.installedDir()).toBe(shippedDir);
    expect(m.state()).toMatchObject({ revision: SHIPPED_REVISION, source: "bundled" });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(same)).toBe(false);
  });

  it("never offers a download older than the shipped copy as an update", async () => {
    const { fetchMock, requests } = hub(repo(OLDER, SHIPPED_AT - DAY));
    vi.stubGlobal("fetch", fetchMock);
    const m = models();
    await m.ensure();

    expect(fetchedFiles(requests)).toEqual([]);
    expect(await m.installedDir()).toBe(shippedDir);
  });

  it("keeps the newest update on this machine and deletes the rest", async () => {
    vi.stubGlobal("fetch", offline());
    const newer = installed(repo(NEWER, SHIPPED_AT + DAY));
    const newest = installed(repo(NEWEST, SHIPPED_AT + 2 * DAY));
    const m = models();

    expect(await m.installedDir()).toBe(newest);
    expect(existsSync(newer)).toBe(false);
  });

  it("never reads with an update that no longer matches its hashes", async () => {
    vi.stubGlobal("fetch", offline());
    const dir = installed(repo(NEWER, SHIPPED_AT + DAY));
    writeFileSync(path.join(dir, "model.int8.onnx"), `INT8-${"x".repeat(NEWER.length)}`);
    const m = models();

    expect(await m.installedDir()).toBe(shippedDir);
    expect(m.state()).toMatchObject({ status: "ready", source: "bundled" });
    expect(existsSync(dir)).toBe(false);
  });

  it("never puts a download that doesn't match the Hub's hashes in place of the copy in use", async () => {
    const corrupt = repo(NEWER, SHIPPED_AT + DAY, { servedWeights: `INT8-${"z".repeat(40)}` });
    const { fetchMock } = hub(corrupt);
    vi.stubGlobal("fetch", fetchMock);
    const m = models();
    await m.ensure();

    expect(await m.installedDir()).toBe(shippedDir);
    expect(m.state()).toEqual({
      id: CANOPY_MODEL,
      status: "ready",
      revision: SHIPPED_REVISION,
      source: "bundled",
    });
    expect(existsSync(path.join(updates, NEWER))).toBe(false);
    // The bad file is gone; the good ones stay for the next try.
    const staging = path.join(updates, `${NEWER}.download`);
    expect(readdirSync(staging).sort()).toEqual([
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
  });

  it("picks up a download the last launch stopped part way, where it stopped", async () => {
    const newer = repo(NEWER, SHIPPED_AT + DAY);
    const first = hub(newer, { hold: "model.int8.onnx" });
    vi.stubGlobal("fetch", first.fetchMock);
    const m = models();
    const ensuring = m.ensure();
    await vi.waitFor(() => {
      const state = m.state();
      expect(state?.status === "ready" && state.update !== undefined).toBe(true);
    });
    // Canopy turned off, or the app quit, part way through the weights.
    const part = path.join(updates, `${NEWER}.download`, "model.int8.onnx.part");
    await vi.waitFor(() => expect(existsSync(part) && statSync(part).size).toBeGreaterThan(0));
    m.cancel();
    first.release();
    await ensuring;
    expect(m.currentDir()).toBe(shippedDir);
    expect(m.state()).toMatchObject({ source: "bundled" });
    expect(m.state()).not.toHaveProperty("update");
    const kept = readFileSync(part).length;
    expect(kept).toBeGreaterThan(0);

    const second = hub(newer);
    vi.stubGlobal("fetch", second.fetchMock);
    const next = models();
    await next.ensure();
    expect(await next.installedDir()).toBe(path.join(updates, NEWER));
    expect(readFileSync(path.join(updates, NEWER, "model.int8.onnx"), "utf8")).toBe(
      `INT8-${NEWER}`
    );
    const weights = second.requests.find((r) => r.url.endsWith("/model.int8.onnx"));
    expect(weights?.range).toBe(`bytes=${kept}-`);
    // config.json is asked for again: it is what the Hub counts a download by.
    expect(fetchedFiles(second.requests)).toContain("config.json");
    // Files already fetched and checked are not.
    expect(fetchedFiles(second.requests)).not.toContain("tokenizer.json");
  });

  it("replaces an update with a newer one, deleting the one it replaced", async () => {
    const previous = installed(repo(NEWER, SHIPPED_AT + DAY));
    const { fetchMock } = hub(repo(NEWEST, SHIPPED_AT + 2 * DAY));
    vi.stubGlobal("fetch", fetchMock);
    const changes = vi.fn();
    const m = models(changes);
    await m.ensure();

    expect(await m.installedDir()).toBe(path.join(updates, NEWEST));
    expect(existsSync(previous)).toBe(false);
  });

  it("deletes a download the Hub has moved on from", async () => {
    const abandoned = path.join(updates, `${NEWER}.download`);
    mkdirSync(abandoned, { recursive: true });
    writeFileSync(path.join(abandoned, "model.int8.onnx.part"), "INT8-");
    const { fetchMock } = hub(repo(SHIPPED_REVISION, SHIPPED_AT));
    vi.stubGlobal("fetch", fetchMock);
    await models().ensure();

    expect(existsSync(abandoned)).toBe(false);
  });

  it("asks nothing when updates are off", async () => {
    const fetchMock = offline();
    vi.stubGlobal("fetch", fetchMock);
    const m = new CanopyModels(shippedDir, () => {}, { shipped: SHIPPED });
    await m.ensure();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await m.installedDir()).toBe(shippedDir);
  });

  it("reads with an update when the shipped copy is damaged", async () => {
    vi.stubGlobal("fetch", offline());
    rmSync(path.join(shippedDir, "model.int8.onnx"));
    const dir = installed(repo(NEWER, SHIPPED_AT + DAY));
    const m = models();

    expect(await m.installedDir()).toBe(dir);
    expect(m.state()).toMatchObject({ status: "ready", source: "update" });
  });
});
