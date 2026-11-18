import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithCanopyModel } from "../build-main.mjs";
import canopyReaderModel from "../lib/canopyReaderModel.cjs";
import { CANOPY_MODEL, CanopyModels } from "../../electron/services/canopy/canopyModels.ts";

const { invalidFiles, prepareModel } = canopyReaderModel;

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

/** The same revision as the running app knows it. */
const SHIPPED = {
  revision: manifest.revision,
  published: Date.parse(manifest.published),
  files: manifest.files,
};

const REVISION_URL = `https://huggingface.co/api/models/${manifest.id}/revision/${manifest.revision}`;
const fileUrl = (name) =>
  `https://huggingface.co/${manifest.id}/resolve/${manifest.revision}/${name}`;

/** A network that answers nothing until each request is let through by hand. */
function holding() {
  const held = new Map();
  const gate = (url) => {
    if (!held.has(url)) {
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      held.set(url, { promise, resolve });
    }
    return held.get(url);
  };
  const fetchImpl = vi.fn((url) => gate(url).promise);
  const answer = async (url, response) => {
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledWith(url, expect.anything()));
    gate(url).resolve(response);
  };
  return { fetchImpl, answer };
}

const revisionAnswer = () =>
  Response.json({ sha: manifest.revision, lastModified: manifest.published });

let checkout;
let modelsRoot;
let modelDir;
let readyFile;

beforeEach(() => {
  // A clean checkout: no model fetched, nothing built.
  checkout = mkdtempSync(path.join(tmpdir(), "canopy-dev-start-"));
  modelsRoot = path.join(checkout, "electron", "resources", "canopy-reader");
  modelDir = path.join(modelsRoot, manifest.revision);
  readyFile = path.join(checkout, "dist-electron", ".build-ready.js");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(checkout, { recursive: true, force: true });
});

describe("a dev watch in a clean checkout whose model fetch is held (#17818)", () => {
  it("is ready to launch the app before the network answers", async () => {
    const { fetchImpl, answer } = holding();
    // What a watch's first successful build leaves for `wait-on` before Electron starts.
    const startBuild = vi.fn(async () => {
      mkdirSync(path.dirname(readyFile), { recursive: true });
      writeFileSync(readyFile, "// build ready\n");
    });
    const warn = vi.fn();

    const { model } = await runWithCanopyModel({
      watch: true,
      prepare: () => prepareModel({ manifest, root: modelsRoot, fetchImpl, log: () => {} }),
      startBuild,
      warn,
    });

    // Built and marked ready while the Hub's first answer is still held.
    expect(startBuild).toHaveBeenCalledTimes(1);
    expect(existsSync(readyFile)).toBe(true);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledWith(REVISION_URL, expect.anything()));
    let prepared = false;
    void model.then(() => (prepared = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(prepared).toBe(false);
    expect(invalidFiles(modelDir, manifest)).toHaveLength(2);

    await answer(REVISION_URL, revisionAnswer());
    await answer(fileUrl("config.json"), new Response(CONFIG));
    await answer(fileUrl("model.int8.onnx"), new Response(WEIGHTS));
    await model;
    expect(invalidFiles(modelDir, manifest)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("has the running app read with the model only once every file checks out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl, answer } = holding();
    const warn = vi.fn();
    const { model } = await runWithCanopyModel({
      watch: true,
      prepare: () => prepareModel({ manifest, root: modelsRoot, fetchImpl, log: () => {} }),
      startBuild: async () => {},
      warn,
    });

    const changes = vi.fn();
    const models = new CanopyModels(modelDir, changes, { shipped: SHIPPED, awaitBundled: true });
    await models.ensure();
    expect(models.state()).toEqual({ id: CANOPY_MODEL, status: "missing" });

    /** Fires the app's next look at the folder and waits until it has armed another, or read with it. */
    const lookOnce = async () => {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersToNextTimerAsync();
      await vi.waitFor(() =>
        expect(vi.getTimerCount() === 1 || models.currentDir() !== null).toBe(true)
      );
    };

    // The config is in place and the weights are still held.
    await answer(REVISION_URL, revisionAnswer());
    await answer(fileUrl("config.json"), new Response(CONFIG));
    await vi.waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledWith(fileUrl("model.int8.onnx"), expect.anything())
    );
    expect(invalidFiles(modelDir, manifest).map((spec) => spec.name)).toEqual(["model.int8.onnx"]);
    await lookOnce();
    expect(models.currentDir()).toBeNull();
    expect(await models.installedDir()).toBeNull();

    // The weights arrive the pinned size but wrong: never put in place, and the watch only warns.
    await answer(fileUrl("model.int8.onnx"), new Response(Buffer.alloc(WEIGHTS.length)));
    await model;
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/isn't ready .*doesn't match/));
    await lookOnce();
    expect(models.currentDir()).toBeNull();
    expect(models.state()?.status).toBe("missing");
    expect(changes).toHaveBeenCalledTimes(1);

    // `npm run fetch:canopy-model` gets it: the app reads with it, never restarted.
    const served = vi.fn(async (url) =>
      url === REVISION_URL
        ? revisionAnswer()
        : new Response(url.endsWith("config.json") ? CONFIG : WEIGHTS)
    );
    await prepareModel({ manifest, root: modelsRoot, fetchImpl: served, log: () => {} });
    await lookOnce();
    expect(models.currentDir()).toBe(modelDir);
    expect(models.state()).toMatchObject({ status: "ready", revision: manifest.revision });
    expect(changes).toHaveBeenCalledTimes(2);
    models.dispose();
  });

  it("never rewrites the folder a running app checked, whatever pin a held fetch was for", async () => {
    // An app built from another branch, its pin's copy checked and in use.
    const otherWeights = Buffer.from("the other pin's weights");
    const other = {
      revision: "b".repeat(40),
      published: Date.parse(manifest.published),
      files: [
        manifest.files[0],
        { name: "model.int8.onnx", size: otherWeights.length, sha256: sha256(otherWeights) },
      ],
    };
    const otherDir = path.join(modelsRoot, other.revision);
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(path.join(otherDir, "config.json"), CONFIG);
    writeFileSync(path.join(otherDir, "model.int8.onnx"), otherWeights);
    const models = new CanopyModels(otherDir, () => {}, { shipped: other, awaitBundled: true });
    await models.ensure();
    expect(models.currentDir()).toBe(otherDir);

    // This checkout's watch was still fetching its own pin when that app checked its copy.
    const { fetchImpl, answer } = holding();
    const { model } = await runWithCanopyModel({
      watch: true,
      prepare: () => prepareModel({ manifest, root: modelsRoot, fetchImpl, log: () => {} }),
      startBuild: async () => {},
      warn: vi.fn(),
    });
    await answer(REVISION_URL, revisionAnswer());
    await answer(fileUrl("config.json"), new Response(CONFIG));
    await answer(fileUrl("model.int8.onnx"), new Response(WEIGHTS));
    await model;

    expect(invalidFiles(modelDir, manifest)).toEqual([]);
    expect(invalidFiles(otherDir, other)).toEqual([]);
    expect(readFileSync(path.join(otherDir, "model.int8.onnx")).equals(otherWeights)).toBe(true);
    models.dispose();
  });
});

describe("the build script", () => {
  it("hands the model to runWithCanopyModel, waiting on it nowhere else", () => {
    const source = readFileSync(new URL("../build-main.mjs", import.meta.url), "utf8");
    const run = source.slice(source.indexOf("async function run()"));
    expect(run).toMatch(
      /await runWithCanopyModel\(\{\s*watch: isWatch,\s*prepare: prepareCanopyReaderModel,/
    );
    expect(run.match(/prepareCanopyReaderModel/g)).toEqual(["prepareCanopyReaderModel"]);
  });
});

describe("a build outside watch", () => {
  it("builds nothing until the model is in place, and finishes with the build", async () => {
    let release;
    const prepare = vi.fn(() => new Promise((resolve) => (release = resolve)));
    let built;
    const startBuild = vi.fn(() => new Promise((resolve) => (built = resolve)));

    let finished = false;
    const run = runWithCanopyModel({ watch: false, prepare, startBuild }).then(
      () => (finished = true)
    );
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
    expect(startBuild).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(startBuild).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    built();
    await run;
    expect(finished).toBe(true);
  });

  it("fails without the model, building nothing", async () => {
    const startBuild = vi.fn(async () => {});
    const warn = vi.fn();

    await expect(
      runWithCanopyModel({
        watch: false,
        prepare: () => Promise.reject(new Error("Looking up 0123456789ab failed: HTTP 503")),
        startBuild,
        warn,
      })
    ).rejects.toThrow(/HTTP 503/);
    expect(startBuild).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
