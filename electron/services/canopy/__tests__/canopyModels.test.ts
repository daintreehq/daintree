import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanopyModels, canopyModelName, isCanopyModelId } from "../canopyModels.js";

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
  thresholds: {
    summary_first: 0.5,
    summary_more: 0.6,
    option: 0.5,
    gate: 0.4,
    gate_categories: [],
  },
});

const blobId = (content: string) => {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};

interface Repo {
  sha: string;
  files: Record<string, string>;
  /** LFS files: served as given, but published under this SHA-256. */
  lfs?: Record<string, string>;
}

/** A fake Hugging Face: the list, each repo's detail, and its files, with Range support. */
function hub(repos: Record<string, Repo>, extraIds: string[] = []) {
  const requests: Array<{ url: string; range: string | null }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    requests.push({ url, range });
    if (url.includes("/api/models?")) {
      return Response.json([...Object.keys(repos), ...extraIds].map((id) => ({ id })));
    }
    const detail = /\/api\/models\/(.+)\?blobs=true$/.exec(url);
    if (detail) {
      const repo = repos[detail[1]!];
      if (!repo) return new Response("", { status: 404 });
      return Response.json({
        sha: repo.sha,
        siblings: Object.entries(repo.files).map(([name, content]) => ({
          rfilename: name,
          size: Buffer.byteLength(content),
          blobId: blobId(content),
          ...(repo.lfs?.[name] ? { lfs: { sha256: repo.lfs[name] } } : {}),
        })),
      });
    }
    const file = /huggingface\.co\/(daintreehq\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(url);
    if (file) {
      const content = repos[file[1]!]?.files[file[3]!];
      if (content === undefined) return new Response("", { status: 404 });
      const bytes = Buffer.from(content);
      if (range) {
        const from = Number(/bytes=(\d+)-/.exec(range)![1]);
        if (from >= bytes.length) return new Response("", { status: 416 });
        return new Response(bytes.subarray(from), { status: 206 });
      }
      return new Response(bytes);
    }
    return new Response("", { status: 404 });
  });
  return { fetchMock, requests };
}

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

function repo(sha: string, weights = "WEIGHTS-" + sha): Repo {
  return {
    sha,
    files: {
      "reader.json": META,
      "tokenizer.json": '{"model":{}}',
      "tokenizer_config.json": "{}",
      "model.int8.onnx": weights,
      "model.fp32.onnx": "never fetched",
      "bench.json": JSON.stringify({
        int8: {
          ms_median: 24.9,
          real: {
            gold: { n: 60, category_coarse: 58 },
            agents: { n: 93, category_coarse: 89 },
            lines_vs_gold: { headline_acc: 0.76, options_exact: 0.74, card_f1: 0.65 },
          },
        },
      }),
    },
    lfs: { "model.int8.onnx": sha256(weights) },
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "canopy-models-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("canopyModels", () => {
  it("names a model published after the build by its size", () => {
    expect(canopyModelName("daintreehq/canopy-reader-150m")).toBe("150M");
    expect(canopyModelName("daintreehq/canopy-reader-1b")).toBe("1B");
  });

  it("takes only the publisher's reader repos as model ids", () => {
    expect(isCanopyModelId("daintreehq/canopy-reader-17m")).toBe(true);
    for (const id of [
      "someone/canopy-reader-17m",
      "daintreehq/canopy-reader-",
      "daintreehq/canopy-reader-17m/../../etc",
      "daintreehq/other",
      42,
    ]) {
      expect(isCanopyModelId(id)).toBe(false);
    }
  });

  it("lists what Hugging Face publishes, sized and measured, smallest first", async () => {
    const { fetchMock } = hub(
      {
        "daintreehq/canopy-reader-150m": repo("c"),
        "daintreehq/canopy-reader-17m": repo("a"),
      },
      // Shares the prefix but is no model: training checkpoints are not offered.
      ["daintreehq/canopy-reader-training"]
    );
    vi.stubGlobal("fetch", fetchMock);
    const models = new CanopyModels(root, () => {});
    const list = await models.list();
    expect(list.map((v) => v.name)).toEqual(["Light", "150M"]);
    const light = list[0]!;
    expect(light.downloadBytes).toBe(
      Buffer.byteLength(META) + 12 + 2 + Buffer.byteLength("WEIGHTS-a")
    );
    expect(light.bench).toMatchObject({ agentCategory: 89, agents: 93, msPerScreen: 25 });
    expect(light).toMatchObject({ installed: false, supported: true });
  });

  it("falls back to the models it was built with when Hugging Face can't be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const list = await new CanopyModels(root, () => {}).list(true);
    expect(list.map((v) => v.name)).toEqual(["Light", "Best"]);
    expect(list.every((v) => v.bench !== null && v.downloadBytes > 0)).toBe(true);
  });

  it("downloads only the files a model needs, checked, into place in one move", async () => {
    const { fetchMock, requests } = hub({ "daintreehq/canopy-reader-17m": repo("a") });
    vi.stubGlobal("fetch", fetchMock);
    const changes = vi.fn();
    const models = new CanopyModels(root, changes);
    await models.list(true);
    await models.ensure("daintreehq/canopy-reader-17m");
    const dir = await models.installedDir("daintreehq/canopy-reader-17m");
    expect(dir).toBe(path.join(root, "canopy-reader-17m"));
    expect(readFileSync(path.join(dir!, "model.int8.onnx"), "utf8")).toBe("WEIGHTS-a");
    expect(existsSync(path.join(dir!, "model.fp32.onnx"))).toBe(false);
    expect(existsSync(`${dir}.download`)).toBe(false);
    // Pinned to the revision listed, never to a moving branch.
    const fetched = requests.filter((r) => r.url.includes("/resolve/")).map((r) => r.url);
    expect(fetched.every((url) => url.includes("/resolve/a/"))).toBe(true);
    expect(fetched.some((url) => url.endsWith("model.fp32.onnx"))).toBe(false);
    expect(models.state("daintreehq/canopy-reader-17m")).toEqual({
      id: "daintreehq/canopy-reader-17m",
      status: "ready",
    });
    expect(changes).toHaveBeenCalled();
    // Still there for the next launch.
    expect(
      await new CanopyModels(root, () => {}).installedDir("daintreehq/canopy-reader-17m")
    ).toBe(dir);
  });

  it("refuses weights that don't match what Hugging Face published, and installs nothing", async () => {
    const bad = repo("a");
    bad.lfs = { "model.int8.onnx": sha256("something else") };
    const { fetchMock } = hub({ "daintreehq/canopy-reader-17m": bad });
    vi.stubGlobal("fetch", fetchMock);
    const models = new CanopyModels(root, () => {});
    await models.list(true);
    await models.ensure("daintreehq/canopy-reader-17m");
    expect(await models.installedDir("daintreehq/canopy-reader-17m")).toBeNull();
    expect(models.state("daintreehq/canopy-reader-17m")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("didn't match"),
    });
  });

  it("picks a stopped download up where it left off", async () => {
    const weights = "W".repeat(64);
    const { fetchMock, requests } = hub({ "daintreehq/canopy-reader-17m": repo("a", weights) });
    vi.stubGlobal("fetch", fetchMock);
    const staging = path.join(root, "canopy-reader-17m.download");
    await mkdir(staging, { recursive: true });
    writeFileSync(path.join(staging, "model.int8.onnx.a.part"), weights.slice(0, 40));
    const models = new CanopyModels(root, () => {});
    await models.list(true);
    await models.ensure("daintreehq/canopy-reader-17m");
    const dir = (await models.installedDir("daintreehq/canopy-reader-17m"))!;
    expect(readFileSync(path.join(dir, "model.int8.onnx"), "utf8")).toBe(weights);
    expect(requests.find((r) => r.url.endsWith("model.int8.onnx"))?.range).toBe("bytes=40-");
  });

  it("refuses a model this build can't read, and downloads none of it", async () => {
    const newer = repo("a");
    newer.files["reader.json"] = JSON.stringify({ max_len: 1024, outputs: ["something_new"] });
    const { fetchMock, requests } = hub({ "daintreehq/canopy-reader-17m": newer });
    vi.stubGlobal("fetch", fetchMock);
    const models = new CanopyModels(root, () => {});
    const list = await models.list(true);
    expect(list[0]!.supported).toBe(false);
    await models.ensure("daintreehq/canopy-reader-17m");
    expect(models.state("daintreehq/canopy-reader-17m")).toMatchObject({ status: "failed" });
    expect(requests.some((r) => r.url.endsWith("model.int8.onnx"))).toBe(false);
  });

  it("downloads a model once however many ask for it at the same time", async () => {
    const { fetchMock, requests } = hub({ "daintreehq/canopy-reader-17m": repo("a") });
    vi.stubGlobal("fetch", fetchMock);
    const models = new CanopyModels(root, () => {});
    await models.list(true);
    await Promise.all([
      models.ensure("daintreehq/canopy-reader-17m"),
      models.ensure("daintreehq/canopy-reader-17m"),
    ]);
    expect(requests.filter((r) => r.url.endsWith("/model.int8.onnx"))).toHaveLength(1);
    expect(await models.installedDir("daintreehq/canopy-reader-17m")).not.toBeNull();
  });

  it("starts nothing when cancelled before the download began", async () => {
    const { fetchMock, requests } = hub({ "daintreehq/canopy-reader-17m": repo("a") });
    vi.stubGlobal("fetch", fetchMock);
    const models = new CanopyModels(root, () => {});
    await models.list(true);
    const before = requests.length;
    // Still checking what is installed when Canopy goes off.
    const pending = models.ensure("daintreehq/canopy-reader-17m");
    models.cancel();
    await pending;
    expect(requests.slice(before)).toEqual([]);
    expect(models.state("daintreehq/canopy-reader-17m")).toMatchObject({ status: "missing" });
    // Turned on again, it downloads.
    await models.ensure("daintreehq/canopy-reader-17m");
    expect(models.state("daintreehq/canopy-reader-17m")).toMatchObject({ status: "ready" });
  });

  it("deletes a half-finished download along with the models", async () => {
    const staging = path.join(root, "canopy-reader-68m.download");
    await mkdir(staging, { recursive: true });
    writeFileSync(path.join(staging, "model.int8.onnx.b.part"), "partial weights");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );
    const models = new CanopyModels(root, () => {});
    await models.removeAllBut(null);
    expect(existsSync(staging)).toBe(false);
  });

  it("finds a model installed after the build, offline", async () => {
    const { fetchMock } = hub({ "daintreehq/canopy-reader-150m": repo("c") });
    vi.stubGlobal("fetch", fetchMock);
    const online = new CanopyModels(root, () => {});
    await online.list(true);
    await online.ensure("daintreehq/canopy-reader-150m");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const offline = new CanopyModels(root, () => {});
    expect(await offline.installedDir("daintreehq/canopy-reader-150m")).toBe(
      path.join(root, "canopy-reader-150m")
    );
  });

  it("deletes every model but the one kept", async () => {
    const { fetchMock } = hub({
      "daintreehq/canopy-reader-17m": repo("a"),
      "daintreehq/canopy-reader-68m": repo("b"),
    });
    vi.stubGlobal("fetch", fetchMock);
    const models = new CanopyModels(root, () => {});
    await models.list(true);
    await models.ensure("daintreehq/canopy-reader-17m");
    await models.ensure("daintreehq/canopy-reader-68m");
    await models.removeAllBut("daintreehq/canopy-reader-68m");
    expect(await models.installedDir("daintreehq/canopy-reader-17m")).toBeNull();
    expect(existsSync(path.join(root, "canopy-reader-17m"))).toBe(false);
    expect(await models.installedDir("daintreehq/canopy-reader-68m")).not.toBeNull();
    await models.removeAllBut(null);
    expect(await models.installedDir("daintreehq/canopy-reader-68m")).toBeNull();
  });
});
