import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANOPY_MODEL,
  CANOPY_READER_WEIGHTS,
  CanopyModels,
  removeDownloadedModels,
  type CanopyModelFileSpec,
} from "../canopyModels.js";
import manifest from "../canopy-reader-manifest.json" with { type: "json" };

const WEIGHTS = Buffer.from("int8 weights, pretend");
const TOKENIZER = Buffer.from('{"model":{"vocab":{}}}');

const gitBlobId = (content: Buffer) =>
  createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
const sha256 = (content: Buffer) => createHash("sha256").update(content).digest("hex");

const FILES: CanopyModelFileSpec[] = [
  { name: "tokenizer.json", size: TOKENIZER.length, blobId: gitBlobId(TOKENIZER) },
  { name: "model.int8.onnx", size: WEIGHTS.length, sha256: sha256(WEIGHTS) },
];

let dir: string;

function ship(contents: Record<string, Buffer> = {}): void {
  writeFileSync(path.join(dir, "tokenizer.json"), contents["tokenizer.json"] ?? TOKENIZER);
  writeFileSync(path.join(dir, "model.int8.onnx"), contents["model.int8.onnx"] ?? WEIGHTS);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "canopy-bundled-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("CanopyModels, the model that ships with Daintree", () => {
  it("reads from the shipped folder once every file matches its pin", async () => {
    ship();
    const changes = vi.fn();
    const models = new CanopyModels(dir, changes, FILES);

    expect(await models.installedDir()).toBe(dir);
    expect(models.state()).toEqual({ id: CANOPY_MODEL, status: "ready" });
    expect(await models.info()).toMatchObject({
      id: CANOPY_MODEL,
      bytes: WEIGHTS.length + TOKENIZER.length,
      installed: true,
    });
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("says nothing of the model until it has been checked", async () => {
    ship();
    const models = new CanopyModels(dir, () => {}, FILES);

    // Made without a look at the disk: a user who never turns Canopy on pays nothing.
    expect(models.state()).toBeUndefined();
    const checked = models.ensure();
    expect(models.state()).toBeUndefined();
    await checked;
    expect(models.state()?.status).toBe("ready");
  });

  it.each([
    ["missing", () => rmSync(path.join(dir, "model.int8.onnx"))],
    ["cut short", () => ship({ "model.int8.onnx": WEIGHTS.subarray(1) })],
    // Same size, different bytes: only the hash can tell.
    ["changed", () => ship({ "model.int8.onnx": Buffer.alloc(WEIGHTS.length, 0x61) })],
    ["a changed tokenizer", () => ship({ "tokenizer.json": Buffer.alloc(TOKENIZER.length, 0x20) })],
  ])("never hands the reader a model whose files are %s", async (_label, damage) => {
    ship();
    damage();
    const changes = vi.fn();
    const models = new CanopyModels(dir, changes, FILES);

    expect(await models.installedDir()).toBeNull();
    const state = models.state();
    expect(state?.status).toBe("failed");
    expect(state?.status === "failed" && state.error).toMatch(/Reinstalling Daintree/);
    expect((await models.info()).installed).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("checks once a launch, however many ask at once or later", async () => {
    ship();
    const changes = vi.fn();
    const models = new CanopyModels(dir, changes, FILES);

    await Promise.all([models.ensure(), models.installedDir(), models.info(), models.ensure()]);
    // Damaged since: the launch's one check stands, nothing is hashed again.
    ship({ "model.int8.onnx": Buffer.alloc(WEIGHTS.length) });
    expect(await models.installedDir()).toBe(dir);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("tells no one of a check that finishes after it is let go", async () => {
    ship();
    const changes = vi.fn();
    const models = new CanopyModels(dir, changes, FILES);

    const checked = models.ensure();
    models.dispose();
    await checked;
    expect(changes).not.toHaveBeenCalled();
  });
});

describe("the tracked manifest", () => {
  it("is the reader Canopy names, with the weights the worker loads pinned by SHA-256", () => {
    expect(manifest.id).toBe(CANOPY_MODEL);
    const weights = manifest.files.find((file) => file.name === CANOPY_READER_WEIGHTS);
    expect(weights && "sha256" in weights && weights.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The reader's meta and tokenizer: everything the worker reads besides the weights.
    expect(manifest.files.map((file) => file.name)).toEqual(
      expect.arrayContaining(["config.json", "tokenizer.json", "tokenizer_config.json"])
    );
  });
});

describe("removeDownloadedModels", () => {
  it("deletes every model an earlier Daintree downloaded, with its half-done and set-aside copies", async () => {
    for (const name of [
      "canopy-reader-17m",
      "canopy-reader-17m.download",
      "canopy-reader-17m.old",
      "canopy-reader-68m",
    ]) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, "model.int8.onnx"), WEIGHTS);
    }

    await removeDownloadedModels(dir);

    // Nothing else was there: the folder goes too.
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves anything that isn't a reader model alone, and the folder holding it", async () => {
    mkdirSync(path.join(dir, "canopy-reader-17m"));
    writeFileSync(path.join(dir, "notes.txt"), "mine");
    mkdirSync(path.join(dir, "other-model"));

    await removeDownloadedModels(dir);

    expect(readdirSync(dir).sort()).toEqual(["notes.txt", "other-model"]);
  });

  it("does nothing when no model was ever downloaded", async () => {
    await expect(removeDownloadedModels(path.join(dir, "absent"))).resolves.toBeUndefined();
  });

  const LINK = process.platform === "win32" ? "junction" : "dir";

  it("leaves a models folder reached through a link alone: another profile or build may share it", async () => {
    const shared = path.join(dir, "shared");
    mkdirSync(path.join(shared, "canopy-reader-17m"), { recursive: true });
    mkdirSync(path.join(dir, "canopy"));
    symlinkSync(shared, path.join(dir, "canopy", "models"), LINK);

    await removeDownloadedModels(path.join(dir, "canopy", "models"));

    expect(existsSync(path.join(shared, "canopy-reader-17m"))).toBe(true);
  });

  it("leaves a canopy folder reached through a link alone, and the models in it", async () => {
    const shared = path.join(dir, "shared");
    mkdirSync(path.join(shared, "models", "canopy-reader-17m"), { recursive: true });
    symlinkSync(shared, path.join(dir, "canopy"), LINK);

    await removeDownloadedModels(path.join(dir, "canopy", "models"));

    expect(existsSync(path.join(shared, "models", "canopy-reader-17m"))).toBe(true);
  });

  it("stops between folders once told to", async () => {
    mkdirSync(path.join(dir, "canopy-reader-17m"));
    mkdirSync(path.join(dir, "canopy-reader-68m"));
    const stop = new AbortController();
    stop.abort();
    await removeDownloadedModels(dir, stop.signal);
    expect(readdirSync(dir).sort()).toEqual(["canopy-reader-17m", "canopy-reader-68m"]);

    // Told while the first folder goes: the next one stays.
    let looks = 0;
    const midway = {
      get aborted() {
        looks += 1;
        return looks > 1;
      },
    } as AbortSignal;
    await removeDownloadedModels(dir, midway);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "goes on to the next folder when one can't be deleted yet",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      // A folder whose contents can't be removed, as a file held open on Windows.
      const stuck = path.join(dir, "canopy-reader-17m", "locked");
      mkdirSync(stuck, { recursive: true });
      writeFileSync(path.join(stuck, "model.int8.onnx"), WEIGHTS);
      chmodSync(stuck, 0o555);
      mkdirSync(path.join(dir, "canopy-reader-68m"));
      try {
        await removeDownloadedModels(dir);
        expect(existsSync(path.join(dir, "canopy-reader-68m"))).toBe(false);
        expect(existsSync(path.join(stuck, "model.int8.onnx"))).toBe(true);
      } finally {
        chmodSync(stuck, 0o755);
      }
    }
  );
});
