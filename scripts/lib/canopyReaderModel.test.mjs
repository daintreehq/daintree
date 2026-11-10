import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import canopyReaderModel from "./canopyReaderModel.cjs";

const { contentMatches, gitBlobId, invalidFiles, prepareModel, readManifest } = canopyReaderModel;

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

const WEIGHTS = Buffer.from("weights, pretend");
const CONFIG = Buffer.from('{"max_len":512}');

const manifest = {
  id: "daintreehq/canopy-reader-17m",
  revision: "0123456789abcdef0123456789abcdef01234567",
  published: "2026-10-25T19:08:24.000Z",
  weights: "model.int8.onnx",
  files: [
    // `printf '{"max_len":512}' | git hash-object --stdin`
    {
      name: "config.json",
      size: CONFIG.length,
      blobId: "c0b091bfc9043c63ce183d096acc27bf89ae0632",
    },
    { name: "model.int8.onnx", size: WEIGHTS.length, sha256: sha256(WEIGHTS) },
  ],
};

const BODIES = { "config.json": CONFIG, "model.int8.onnx": WEIGHTS };

const REVISION_URL = `https://huggingface.co/api/models/${manifest.id}/revision/${manifest.revision}`;

function serving(bodies = BODIES, published = manifest.published) {
  return vi.fn(async (url) => {
    if (url === REVISION_URL) {
      return Response.json({ sha: manifest.revision, lastModified: published });
    }
    const name = url.slice(url.lastIndexOf("/") + 1);
    const body = bodies[name];
    if (!body) return new Response(null, { status: 404 });
    return new Response(body, { status: 200 });
  });
}

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "canopy-reader-model-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("gitBlobId", () => {
  it("is git's own blob id", () => {
    // `printf 'hello\n' | git hash-object --stdin`, and the same for each below.
    expect(gitBlobId(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(gitBlobId(Buffer.from("hello world\n"))).toBe(
      "3b18e512dba79e4c8300dd08aeb37f8e728b8dad"
    );
    expect(gitBlobId(CONFIG)).toBe(manifest.files[0].blobId);
  });
});

describe("contentMatches", () => {
  it("rejects a file of the right size whose bytes differ", () => {
    const spec = manifest.files[1];
    const same = Buffer.alloc(WEIGHTS.length, 0x61);
    expect(contentMatches(WEIGHTS, spec)).toBe(true);
    expect(contentMatches(same, spec)).toBe(false);
  });

  it("rejects a blob-pinned file of the right size whose bytes differ", () => {
    // Same length, one digit apart.
    expect(contentMatches(Buffer.from('{"max_len":513}'), manifest.files[0])).toBe(false);
    expect(contentMatches(CONFIG, manifest.files[0])).toBe(true);
  });

  it("rejects a file whose size isn't the one pinned, even when its hash is", () => {
    const spec = manifest.files[1];
    expect(contentMatches(WEIGHTS, { ...spec, size: spec.size + 1 })).toBe(false);
  });

  it("rejects a spec that pins no hash", () => {
    expect(contentMatches(WEIGHTS, { name: "x", size: WEIGHTS.length })).toBe(false);
  });
});

describe("invalidFiles", () => {
  it("names the files missing, cut short or changed", () => {
    writeFileSync(path.join(dir, "config.json"), CONFIG.subarray(1));
    expect(invalidFiles(dir, manifest).map((f) => f.name)).toEqual([
      "config.json",
      "model.int8.onnx",
    ]);

    writeFileSync(path.join(dir, "config.json"), CONFIG);
    writeFileSync(path.join(dir, "model.int8.onnx"), WEIGHTS);
    expect(invalidFiles(dir, manifest)).toEqual([]);

    // Changed on disk without changing size: only the hash can tell.
    writeFileSync(path.join(dir, "model.int8.onnx"), Buffer.alloc(WEIGHTS.length, 0x61));
    expect(invalidFiles(dir, manifest).map((f) => f.name)).toEqual(["model.int8.onnx"]);
  });
});

describe("prepareModel", () => {
  it("fetches every file from the pinned revision into an empty folder", async () => {
    const fetchImpl = serving();

    const { fetched } = await prepareModel({ dir, manifest, fetchImpl, log: () => {} });

    expect(fetched).toEqual(["config.json", "model.int8.onnx"]);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      REVISION_URL,
      `https://huggingface.co/${manifest.id}/resolve/${manifest.revision}/config.json`,
      `https://huggingface.co/${manifest.id}/resolve/${manifest.revision}/model.int8.onnx`,
    ]);
    expect(readFileSync(path.join(dir, "model.int8.onnx")).equals(WEIGHTS)).toBe(true);
    expect(invalidFiles(dir, manifest)).toEqual([]);
  });

  it("asks nothing of Hugging Face when the folder already matches", async () => {
    writeFileSync(path.join(dir, "config.json"), CONFIG);
    writeFileSync(path.join(dir, "model.int8.onnx"), WEIGHTS);
    const fetchImpl = serving();

    const { fetched } = await prepareModel({ dir, manifest, fetchImpl, log: () => {} });

    expect(fetched).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches only the file that is wrong, keeping a good config.json", async () => {
    writeFileSync(path.join(dir, "config.json"), CONFIG);
    writeFileSync(path.join(dir, "model.int8.onnx"), Buffer.from("stale"));
    const fetchImpl = serving();

    await prepareModel({ dir, manifest, fetchImpl, log: () => {} });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      REVISION_URL,
      `https://huggingface.co/${manifest.id}/resolve/${manifest.revision}/model.int8.onnx`,
    ]);
    expect(readFileSync(path.join(dir, "model.int8.onnx")).equals(WEIGHTS)).toBe(true);
    expect(readFileSync(path.join(dir, "config.json")).equals(CONFIG)).toBe(true);
    expect(invalidFiles(dir, manifest)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["config.json", "model.int8.onnx"]);
  });

  it("never puts a file in place that doesn't match its pin", async () => {
    const fetchImpl = serving({ ...BODIES, "model.int8.onnx": Buffer.alloc(WEIGHTS.length) });

    await expect(prepareModel({ dir, manifest, fetchImpl, log: () => {} })).rejects.toThrow(
      /model\.int8\.onnx doesn't match/
    );
    expect(existsSync(path.join(dir, "model.int8.onnx"))).toBe(false);
    expect(readdirSync(dir).some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("leaves no staging file behind when a fetched file can't be put in place", async () => {
    // A folder where the weights belong: the rename over it fails.
    mkdirSync(path.join(dir, "model.int8.onnx"));
    writeFileSync(path.join(dir, "model.int8.onnx", "keep"), "x");
    const fetchImpl = serving();

    await expect(prepareModel({ dir, manifest, fetchImpl, log: () => {} })).rejects.toThrow();
    expect(existsSync(path.join(dir, "model.int8.onnx.part"))).toBe(false);
    expect(existsSync(path.join(dir, "model.int8.onnx", "keep"))).toBe(true);
  });

  it("refuses a manifest whose published date isn't the pinned revision's, fetching nothing", async () => {
    const fetchImpl = serving(BODIES, "2026-10-24T00:00:00.000Z");

    await expect(prepareModel({ dir, manifest, fetchImpl, log: () => {} })).rejects.toThrow(
      /published in .* is 2026-10-25T19:08:24\.000Z, but Hugging Face published 0123456789ab at 2026-10-24/
    );
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([REVISION_URL]);
    expect(existsSync(path.join(dir, "model.int8.onnx"))).toBe(false);
  });

  it("fails on an HTTP error", async () => {
    const fetchImpl = serving({ "config.json": CONFIG });

    await expect(prepareModel({ dir, manifest, fetchImpl, log: () => {} })).rejects.toThrow(
      /model\.int8\.onnx failed: HTTP 404/
    );
  });
});

describe("the tracked manifest", () => {
  it("pins a hash for every file, and names the weights among them", () => {
    const real = readManifest();
    expect(real.files.every((f) => Boolean(f.sha256 || f.blobId) && f.size > 0)).toBe(true);
    expect(real.files.map((f) => f.name)).toContain(real.weights);
    // What the app orders revisions by.
    expect(Number.isFinite(Date.parse(real.published))).toBe(true);
  });
});
