import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANOPY_MODEL, CanopyModels, canopyModelName, isCanopyModelId } from "../canopyModels.js";

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
    second: 0.7,
    card: "summary-only",
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

/** A fake Hugging Face: the model's detail, and its files at any revision, with Range support. */
function hub(repo: Repo | null) {
  const requests: Array<{ url: string; range: string | null }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    requests.push({ url, range });
    if (url.endsWith(`/api/models/${CANOPY_MODEL}?blobs=true`)) {
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
    if (file && repo && file[1] === CANOPY_MODEL) {
      const content = repo.files[file[3]!];
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
      "config.json": META,
      "reader.json": META,
      "tokenizer.json": '{"model":{}}',
      "tokenizer_config.json": "{}",
      "model.int8.onnx": weights,
      "model.fp32.onnx": "FP32-" + weights,
    },
    lfs: { "model.int8.onnx": sha256(weights), "model.fp32.onnx": sha256("FP32-" + weights) },
  };
}

const offline = () =>
  vi.fn(async () => {
    throw new TypeError("fetch failed");
  });

const modelDir = () => path.join(root, "canopy-reader-17m");
const installedRevision = () =>
  JSON.parse(readFileSync(path.join(modelDir(), "install.json"), "utf8")).revision as string;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "canopy-models-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("canopyModels", () => {
  it("calls the model Light, and a model of another size by its size", () => {
    expect(canopyModelName(CANOPY_MODEL)).toBe("Light");
    expect(canopyModelName("daintreehq/canopy-reader-150m")).toBe("150M");
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

  it("downloads the newest revision's INT8 weights and config.json, checked, into place in one move", async () => {
    const { fetchMock, requests } = hub(repo("a"));
    vi.stubGlobal("fetch", fetchMock);
    const changes = vi.fn();
    const models = new CanopyModels(root, changes);
    await models.ensure();
    const dir = await models.installedDir();
    expect(dir).toBe(modelDir());
    expect(readFileSync(path.join(dir!, "model.int8.onnx"), "utf8")).toBe("WEIGHTS-a");
    expect(readFileSync(path.join(dir!, "config.json"), "utf8")).toBe(META);
    expect(existsSync(path.join(dir!, "model.fp32.onnx"))).toBe(false);
    expect(existsSync(path.join(dir!, "reader.json"))).toBe(false);
    expect(existsSync(`${dir}.download`)).toBe(false);
    // Pinned to the revision Hugging Face named, never to a moving branch.
    const fetched = requests.filter((r) => r.url.includes("/resolve/")).map((r) => r.url);
    expect(fetched.filter((url) => url.endsWith("/config.json"))).toHaveLength(1);
    expect(fetched.some((url) => url.endsWith(".fp32.onnx"))).toBe(false);
    expect(fetched.every((url) => url.includes("/resolve/a/"))).toBe(true);
    expect(models.state()).toEqual({ id: CANOPY_MODEL, status: "ready" });
    expect(changes).toHaveBeenCalled();
    // Still there for the next launch.
    expect(await new CanopyModels(root, () => {}).installedDir()).toBe(dir);
  });

  it("looks for an update through the Hub API, never by asking for config.json", async () => {
    const { fetchMock, requests } = hub(repo("a"));
    vi.stubGlobal("fetch", fetchMock);
    await new CanopyModels(root, () => {}).ensure();
    requests.length = 0;
    // The next launch, nothing new published.
    await new CanopyModels(root, () => {}).ensure();
    expect(requests.map((r) => r.url)).toEqual([
      `https://huggingface.co/api/models/${CANOPY_MODEL}?blobs=true`,
      "https://huggingface.co/daintreehq/canopy-reader-17m/resolve/a/reader.json",
    ]);
  });

  it("asks Hugging Face once a launch", async () => {
    const { fetchMock, requests } = hub(repo("a"));
    vi.stubGlobal("fetch", fetchMock);
    const models = new CanopyModels(root, () => {});
    await models.ensure();
    requests.length = 0;
    await models.ensure();
    expect(requests).toEqual([]);
  });

  it("updates an older install to the newest revision, reading with the old one meanwhile", async () => {
    vi.stubGlobal("fetch", hub(repo("a")).fetchMock);
    await new CanopyModels(root, () => {}).ensure();
    const { fetchMock } = hub(repo("b"));
    // The new weights held back until the test lets them through.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let downloading!: () => void;
    const started = new Promise<void>((resolve) => (downloading = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/model.int8.onnx")) {
          downloading();
          await held;
        }
        return fetchMock(url, init);
      })
    );
    const released = vi.fn();
    const replaced = vi.fn();
    const models = new CanopyModels(root, () => {}, released, replaced);
    const update = models.ensure();
    await started;
    // Mid-update: the old revision still reads.
    expect(models.state()).toEqual({ id: CANOPY_MODEL, status: "ready" });
    expect(await models.installedDir()).toBe(modelDir());
    expect(readFileSync(path.join(modelDir(), "model.int8.onnx"), "utf8")).toBe("WEIGHTS-a");
    expect(released).not.toHaveBeenCalled();
    release();
    await update;
    expect(released).toHaveBeenCalledTimes(1);
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(installedRevision()).toBe("b");
    expect(readFileSync(path.join(modelDir(), "model.int8.onnx"), "utf8")).toBe("WEIGHTS-b");
    expect(existsSync(`${modelDir()}.old`)).toBe(false);
    expect(await models.installedDir()).toBe(modelDir());
  });

  it("puts the last revision back when a launch finds an update cut short mid-move", async () => {
    vi.stubGlobal("fetch", hub(repo("a")).fetchMock);
    await new CanopyModels(root, () => {}).ensure();
    // Moved aside, the new one never moved in.
    renameSync(modelDir(), `${modelDir()}.old`);
    vi.stubGlobal("fetch", offline());
    const models = new CanopyModels(root, () => {});
    expect(await models.installedDir()).toBe(modelDir());
    expect(installedRevision()).toBe("a");
  });

  it("never downgrades an install when the newest revision is one this build can't read", async () => {
    vi.stubGlobal("fetch", hub(repo("newer-than-bundled")).fetchMock);
    await new CanopyModels(root, () => {}).ensure();
    const unreadable = repo("later");
    unreadable.files["reader.json"] = JSON.stringify({ outputs: ["something_new"] });
    const { fetchMock, requests } = hub(unreadable);
    vi.stubGlobal("fetch", fetchMock);
    await new CanopyModels(root, () => {}).ensure();
    expect(installedRevision()).toBe("newer-than-bundled");
    expect(
      requests.some((r) => r.url.includes("/resolve/") && !r.url.endsWith("reader.json"))
    ).toBe(false);
  });

  it("asks for config.json on every download, even when an earlier one left it staged", async () => {
    const { fetchMock, requests } = hub(repo("a"));
    vi.stubGlobal("fetch", fetchMock);
    const staging = `${modelDir()}.download`;
    await mkdir(staging, { recursive: true });
    writeFileSync(path.join(staging, "config.json"), META);
    await new CanopyModels(root, () => {}).ensure();
    expect(requests.filter((r) => r.url.endsWith("/resolve/a/config.json"))).toHaveLength(1);
  });

  it("keeps an older install when the update fails, and says nothing failed", async () => {
    vi.stubGlobal("fetch", hub(repo("a")).fetchMock);
    await new CanopyModels(root, () => {}).ensure();
    const bad = repo("b");
    bad.lfs = { "model.int8.onnx": sha256("something else") };
    vi.stubGlobal("fetch", hub(bad).fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const models = new CanopyModels(root, () => {});
    await models.ensure();
    warn.mockRestore();
    expect(models.state()).toEqual({ id: CANOPY_MODEL, status: "ready" });
    expect(installedRevision()).toBe("a");
  });

  it("keeps an install offline, whatever revision it is", async () => {
    vi.stubGlobal("fetch", hub(repo("a")).fetchMock);
    await new CanopyModels(root, () => {}).ensure();
    const fetchMock = offline();
    vi.stubGlobal("fetch", fetchMock);
    const models = new CanopyModels(root, () => {});
    await models.ensure();
    expect(models.state()).toMatchObject({ status: "ready" });
    expect(installedRevision()).toBe("a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves an install alone when the newest revision is one this build can't read", async () => {
    vi.stubGlobal("fetch", hub(repo("a")).fetchMock);
    await new CanopyModels(root, () => {}).ensure();
    const newer = repo("b");
    newer.files["reader.json"] = JSON.stringify({ max_len: 1024, outputs: ["something_new"] });
    const { fetchMock, requests } = hub(newer);
    vi.stubGlobal("fetch", fetchMock);
    await new CanopyModels(root, () => {}).ensure();
    expect(installedRevision()).toBe("a");
    expect(requests.some((r) => r.url.endsWith(".onnx"))).toBe(false);
  });

  it("refuses a revision with a card this build doesn't know", async () => {
    const newer = repo("b");
    const meta = JSON.parse(META) as { thresholds: Record<string, unknown> };
    meta.thresholds.card = "something-else";
    newer.files["reader.json"] = JSON.stringify(meta);
    const { fetchMock, requests } = hub(newer);
    vi.stubGlobal("fetch", fetchMock);
    await new CanopyModels(root, () => {}).ensure();
    // The revision it was built with instead, whose files this fake doesn't hold.
    expect(requests.some((r) => r.url.includes("/resolve/b/model"))).toBe(false);
  });

  it("refuses weights that don't match what Hugging Face published, and installs nothing", async () => {
    const bad = repo("a");
    bad.lfs = { "model.int8.onnx": sha256("something else") };
    vi.stubGlobal("fetch", hub(bad).fetchMock);
    const models = new CanopyModels(root, () => {});
    await models.ensure();
    expect(await models.installedDir()).toBeNull();
    expect(models.state()).toMatchObject({
      status: "failed",
      error: expect.stringContaining("didn't match"),
    });
  });

  it("picks a stopped download up where it left off", async () => {
    const weights = "W".repeat(64);
    const { fetchMock, requests } = hub(repo("a", weights));
    vi.stubGlobal("fetch", fetchMock);
    const staging = `${modelDir()}.download`;
    await mkdir(staging, { recursive: true });
    writeFileSync(path.join(staging, "model.int8.onnx.a.part"), weights.slice(0, 40));
    const models = new CanopyModels(root, () => {});
    await models.ensure();
    expect(readFileSync(path.join(modelDir(), "model.int8.onnx"), "utf8")).toBe(weights);
    expect(requests.find((r) => r.url.endsWith("model.int8.onnx"))?.range).toBe("bytes=40-");
  });

  it("downloads once however many ask for it at the same time", async () => {
    const { fetchMock, requests } = hub(repo("a"));
    vi.stubGlobal("fetch", fetchMock);
    const models = new CanopyModels(root, () => {});
    await Promise.all([models.ensure(), models.ensure()]);
    expect(requests.filter((r) => r.url.endsWith("/model.int8.onnx"))).toHaveLength(1);
    expect(await models.installedDir()).not.toBeNull();
  });

  it("starts nothing when cancelled before the download began", async () => {
    const { fetchMock, requests } = hub(repo("a"));
    vi.stubGlobal("fetch", fetchMock);
    const models = new CanopyModels(root, () => {});
    // Still checking what is installed when Canopy goes off.
    const pending = models.ensure();
    models.cancel();
    await pending;
    expect(requests).toEqual([]);
    expect(models.state()).toMatchObject({ status: "missing" });
    // Turned on again, it downloads.
    await models.ensure();
    expect(models.state()).toMatchObject({ status: "ready" });
  });

  it("says what is on this machine, or what a download fetches", async () => {
    vi.stubGlobal("fetch", hub(repo("a")).fetchMock);
    const models = new CanopyModels(root, () => {});
    // Nothing asked yet: the revision it was built with.
    expect(await models.info()).toEqual({
      id: CANOPY_MODEL,
      name: "Light",
      bytes: 1703 + 3_583_228 + 368 + 17_410_374,
      installed: false,
    });
    await models.ensure();
    const installed = Buffer.byteLength(META) + 12 + 2 + Buffer.byteLength("WEIGHTS-a");
    // What is on disk now, the record of it included, not what a download would fetch.
    const onDisk = installed + statSync(path.join(modelDir(), "install.json")).size;
    expect(await models.info()).toMatchObject({ installed: true, bytes: installed });
    expect(await new CanopyModels(root, () => {}).info()).toMatchObject({
      installed: true,
      bytes: onDisk,
    });
  });

  it("deletes while Canopy is turned on again meanwhile, then downloads once the deletion is done", async () => {
    vi.stubGlobal("fetch", hub(repo("a")).fetchMock);
    const models = new CanopyModels(root, () => {});
    await models.ensure();
    // Two deletions queued, and Canopy turned on between them.
    const first = models.remove(false);
    const second = models.remove(false);
    const download = models.ensure();
    await Promise.all([first, second, download]);
    expect(await models.installedDir()).toBe(modelDir());
  });

  it("deletes the models an earlier Daintree could choose, and keeps the one in use", async () => {
    vi.stubGlobal("fetch", hub(repo("a")).fetchMock);
    const models = new CanopyModels(root, () => {});
    await models.ensure();
    const best = path.join(root, "canopy-reader-68m");
    await mkdir(best, { recursive: true });
    writeFileSync(path.join(best, "install.json"), "{}");
    const staging = path.join(root, "canopy-reader-68m.download");
    await mkdir(staging, { recursive: true });
    writeFileSync(path.join(staging, "model.int8.onnx.b.part"), "partial weights");
    await models.remove(true);
    expect(existsSync(best)).toBe(false);
    expect(existsSync(staging)).toBe(false);
    expect(await models.installedDir()).toBe(modelDir());
    await models.remove(false);
    expect(await models.installedDir()).toBeNull();
    expect(existsSync(modelDir())).toBe(false);
  });
});
