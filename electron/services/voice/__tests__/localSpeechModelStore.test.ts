import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSpeechModelStatus } from "../../../../shared/types/voice.js";
import { localSpeechSupported, LocalSpeechModelStore } from "../localSpeechModelStore.js";
import { LOCAL_SPEECH_MODEL, type LocalSpeechFileSpec } from "../localSpeechModelSpec.js";

const REVISION = LOCAL_SPEECH_MODEL.revision;
const CONTENT: Record<string, Buffer> = {
  "encoder.onnx": Buffer.from("encoder graph"),
  "encoder.onnx.data": Buffer.alloc(4096, 7),
  "vocab.txt": Buffer.from("<unk>\n▁a\n<blank>\n"),
};
const FILES: LocalSpeechFileSpec[] = Object.entries(CONTENT).map(([name, data]) => ({
  name,
  size: data.length,
  sha256: createHash("sha256").update(data).digest("hex"),
}));

interface Served {
  /** Bytes of the body to send before the stream errors; undefined sends it all. */
  cutAfter?: number;
  status?: number;
  corrupt?: boolean;
}

function fakeFetch(plan: Record<string, Served[]> = {}) {
  const requests: Array<{ name: string; range: string | null }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const name = url.slice(url.lastIndexOf("/") + 1);
    expect(url).toContain(`/resolve/${REVISION}/`);
    const range = new Headers(init.headers).get("Range");
    requests.push({ name, range });
    const served = plan[name]?.shift() ?? {};
    const data = served.corrupt ? Buffer.alloc(CONTENT[name].length, 1) : CONTENT[name];
    if (served.status && served.status !== 200 && served.status !== 206) {
      return new Response("nope", { status: served.status });
    }
    const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const body = data.subarray(from);
    const sent = served.cutAfter === undefined ? body : body.subarray(0, served.cutAfter);
    // The cut comes a moment after the data, as a reset connection's does, so
    // what arrived has been written.
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new Uint8Array(sent));
        } else if (served.cutAfter !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.error(new Error("connection reset"));
        } else {
          controller.close();
        }
      },
    });
    return range
      ? new Response(stream, {
          status: 206,
          headers: { "content-range": `bytes ${from}-${data.length - 1}/${data.length}` },
        })
      : new Response(stream, { status: 200 });
  });
  return { fetch, requests };
}

let root: string;
let statuses: LocalSpeechModelStatus[];

function store(fetch: ReturnType<typeof fakeFetch>["fetch"], supported = true) {
  return new LocalSpeechModelStore(root, (status) => statuses.push(status), {
    fetch,
    supported,
    files: FILES,
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "local-speech-store-"));
  statuses = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalSpeechModelStore", () => {
  it("reads absent with nothing on disk, without a request", async () => {
    const { fetch } = fakeFetch();
    expect((await store(fetch).check()).state).toBe("absent");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("downloads every pinned file, checks them and installs the folder", async () => {
    const { fetch } = fakeFetch();
    const models = store(fetch);
    await models.download();
    expect(models.status()).toMatchObject({
      state: "ready",
      receivedBytes: models.status().totalBytes,
    });
    expect(await models.readyDir()).toBe(path.join(root, REVISION));
    for (const [name, data] of Object.entries(CONTENT)) {
      expect(await readFile(path.join(root, REVISION, name))).toEqual(data);
    }
    expect(statuses.map((s) => s.state)).toContain("checking");
    // The staging folder is what was moved into place.
    await expect(stat(path.join(root, `${REVISION}.download`))).rejects.toThrow();
  });

  it("resumes a file cut off part way from where it stopped", async () => {
    const { fetch, requests } = fakeFetch({ "encoder.onnx.data": [{ cutAfter: 1000 }] });
    const models = store(fetch);
    await models.download();
    expect(models.status().state).toBe("failed");
    expect(models.status().receivedBytes).toBeGreaterThanOrEqual(1000);
    await models.download();
    expect(models.status().state).toBe("ready");
    const resumed = requests.filter((r) => r.name === "encoder.onnx.data");
    expect(resumed.map((r) => r.range)).toEqual([null, "bytes=1000-"]);
    // A file already finished isn't fetched twice.
    expect(requests.filter((r) => r.name === "encoder.onnx")).toHaveLength(1);
  });

  it("refuses files that don't match their hash, and fetches them afresh next time", async () => {
    const { fetch, requests } = fakeFetch({ "vocab.txt": [{ corrupt: true }] });
    const models = store(fetch);
    await models.download();
    expect(models.status()).toMatchObject({ state: "failed" });
    expect(models.status().error).toMatch(/don't match/);
    expect(await models.readyDir()).toBeNull();
    await models.download();
    expect(models.status().state).toBe("ready");
    expect(requests.filter((r) => r.name === "vocab.txt").map((r) => r.range)).toEqual([
      null,
      null,
    ]);
  });

  it("reports a refused request as a failure to retry", async () => {
    const { fetch } = fakeFetch({ "encoder.onnx": [{ status: 503 }] });
    const models = store(fetch);
    await models.download();
    expect(models.status()).toMatchObject({ state: "failed" });
    expect(models.status().error).toMatch(/HTTP 503/);
  });

  it("finds an installed model on the next launch, and fails one whose files changed", async () => {
    const { fetch } = fakeFetch();
    await store(fetch).download();
    expect((await store(fetch).check()).state).toBe("ready");
    await writeFile(path.join(root, REVISION, "vocab.txt"), "tampered");
    const damaged = await store(fetch).check();
    expect(damaged.state).toBe("failed");
    expect(damaged.error).toMatch(/damaged/);
  });

  it("joins a download already under way", async () => {
    const { fetch } = fakeFetch();
    const models = store(fetch);
    await Promise.all([models.download(), models.download()]);
    expect(fetch).toHaveBeenCalledTimes(FILES.length);
  });

  it("cancels a download, keeping what it fetched", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetch: inner } = fakeFetch();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("encoder.onnx.data")) {
        await gate;
        if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      }
      return inner(url, init);
    });
    const models = store(fetch as unknown as ReturnType<typeof fakeFetch>["fetch"]);
    const download = models.download();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const cancelled = models.cancel();
    release();
    await cancelled;
    await download;
    expect(models.status()).toMatchObject({ state: "absent" });
    expect(models.status().receivedBytes).toBe(CONTENT["encoder.onnx"].length);
  });

  it("deletes the installed model and any partial download", async () => {
    const { fetch } = fakeFetch();
    const models = store(fetch);
    await models.download();
    await mkdir(path.join(root, `${REVISION}.download`), { recursive: true });
    await models.remove();
    expect(models.status()).toMatchObject({ state: "absent", receivedBytes: 0 });
    await expect(stat(path.join(root, REVISION))).rejects.toThrow();
    await expect(stat(path.join(root, `${REVISION}.download`))).rejects.toThrow();
  });

  it("never fetches on a platform that can't run it", async () => {
    const { fetch } = fakeFetch();
    const models = store(fetch, false);
    await models.download();
    expect((await models.check()).state).toBe("unsupported");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("localSpeechSupported", () => {
  it("rules out the targets ONNX Runtime ships no build for", () => {
    expect(localSpeechSupported("darwin", "x64")).toBe(false);
    expect(localSpeechSupported("darwin", "arm64")).toBe(true);
    expect(localSpeechSupported("win32", "x64")).toBe(true);
    expect(localSpeechSupported("linux", "arm64")).toBe(true);
  });
});
