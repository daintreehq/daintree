import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const userDataRoot = { current: "" };

vi.mock("electron", () => ({
  app: {
    getPath: (key: string) => {
      if (key === "userData") return userDataRoot.current;
      throw new Error(`unexpected getPath: ${key}`);
    },
  },
}));

const logInfo = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
vi.mock("../../utils/logger.js", () => ({ logError, logInfo }));

type Service = typeof import("../AssistantRunCheckpointService.js");
type Scratch = typeof import("../AssistantScratchService.js");

let svc: Service;
let tmpDir: string;
const DAY = 24 * 60 * 60 * 1000;
const PROJECT = "a".repeat(64);

async function loadFresh(): Promise<{ svc: Service; scratch: Scratch }> {
  vi.resetModules();
  return {
    svc: await import("../AssistantRunCheckpointService.js"),
    scratch: await import("../AssistantScratchService.js"),
  };
}

/** Stand-in for a conforming Assistant: temp file in the same folder, then rename. */
async function writeAtomic(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, file);
}

async function startRun(
  project: string,
  runId: string,
  writerId: string,
  body: object = { schemaVersion: 1, intent: "x" }
): Promise<string> {
  const bucket = svc.getRunCheckpointBucket(project);
  await fs.mkdir(bucket, { recursive: true });
  await fs.mkdir(path.join(bucket, runId), { recursive: true });
  const writer = path.join(bucket, runId, "writers", writerId);
  await writeAtomic(path.join(writer, "checkpoint.json"), JSON.stringify(body));
  return writer;
}

async function finish(writer: string, ageMs = 0): Promise<void> {
  const file = path.join(writer, "done.json");
  await writeAtomic(file, JSON.stringify({ schemaVersion: 1, status: "completed" }));
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    await fs.utimes(file, t, t);
  }
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false
  );

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-run-checkpoint-test-"));
  userDataRoot.current = tmpDir;
  logInfo.mockClear();
  logError.mockClear();
  ({ svc } = await loadFresh());
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("bucket provisioning", () => {
  it("keys the bucket by project id under a root separate from scratch", async () => {
    const bucket = await svc.provisionRunCheckpointBucket(PROJECT);
    expect(bucket).toBe(path.join(tmpDir, "assistant-run-checkpoints", PROJECT));
    expect((await fs.stat(bucket)).isDirectory()).toBe(true);
    expect(bucket.startsWith(path.join(tmpDir, "assistant-scratch"))).toBe(false);
  });

  it("is idempotent and supports the global bucket", async () => {
    await svc.provisionRunCheckpointBucket(PROJECT);
    await expect(svc.provisionRunCheckpointBucket(PROJECT)).resolves.toBeTruthy();
    const global = await svc.provisionRunCheckpointBucket(svc.ASSISTANT_GLOBAL_CHECKPOINT_BUCKET);
    expect(path.basename(global)).toBe("global");
  });

  it("refuses an existing bucket that is a symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-run-checkpoint-out-"));
    try {
      await fs.mkdir(svc.getRunCheckpointRoot(), { recursive: true });
      await fs.symlink(outside, svc.getRunCheckpointBucket(PROJECT), "dir");
      await expect(svc.provisionRunCheckpointBucket(PROJECT)).rejects.toThrow();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.each(["", "..", "../x", "a/b", "a\\b", "a".repeat(129), "x\0y"])(
    "rejects unsafe project key %j",
    async (key) => {
      await expect(svc.provisionRunCheckpointBucket(key)).rejects.toThrow();
    }
  );
});

describe("restart persistence", () => {
  it("keeps a checkpoint across a full module reload while scratch is cleared", async () => {
    const first = await loadFresh();
    svc = first.svc;
    await first.scratch.startAssistantScratchCleanup();
    const scratchFile = path.join(first.scratch.getScratchDirForSession("s1"), "note.txt");
    await writeAtomic(scratchFile, "disposable");
    await svc.provisionRunCheckpointBucket(PROJECT);
    const writer = await startRun(PROJECT, "run-1", "w1", { schemaVersion: 1, intent: "ship" });

    // "Relaunch": new module graph, so a new scratch instanceId and no in-memory state.
    const second = await loadFresh();
    svc = second.svc;
    await second.scratch.startAssistantScratchCleanup();
    await svc.requestAssistantRunCheckpointRetention();

    expect(await exists(scratchFile)).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(writer, "checkpoint.json"), "utf-8"))).toEqual({
      schemaVersion: 1,
      intent: "ship",
    });
    expect(await svc.discoverRuns(PROJECT)).toEqual([
      { runId: "run-1", state: "unfinished", settledAt: null },
    ]);
  });

  it("tells an empty store from an unreadable one", async () => {
    expect(await svc.discoverRuns(PROJECT)).toEqual([]);
    await svc.provisionRunCheckpointBucket(PROJECT);
    expect(await svc.discoverRuns(PROJECT)).toEqual([]);

    // A file where the bucket should be is an I/O failure, not "no runs".
    await fs.rm(svc.getRunCheckpointBucket(PROJECT), { recursive: true });
    await fs.writeFile(svc.getRunCheckpointBucket(PROJECT), "x");
    await expect(svc.discoverRuns(PROJECT)).rejects.toThrow();
  });
});

describe("concurrency", () => {
  it("keeps writers of one run, lanes of one project and separate projects apart", async () => {
    const [a, b, c] = await Promise.all([
      startRun(PROJECT, "run-1", "lane-a", { schemaVersion: 1, who: "a" }),
      startRun(PROJECT, "run-1", "lane-b", { schemaVersion: 1, who: "b" }),
      startRun("b".repeat(64), "run-1", "lane-a", { schemaVersion: 1, who: "c" }),
    ]);
    const who = async (w: string) =>
      JSON.parse(await fs.readFile(path.join(w, "checkpoint.json"), "utf-8")).who;
    expect([await who(a), await who(b), await who(c)]).toEqual(["a", "b", "c"]);
  });

  it("does not erase another instance's active run when a second instance sweeps", async () => {
    await startRun(PROJECT, "active", "w1");
    const other = await loadFresh();
    await other.svc.runAssistantRunCheckpointRetention(Date.now() + 365 * DAY);
    expect(await svc.discoverRuns(PROJECT)).toEqual([
      { runId: "active", state: "unfinished", settledAt: null },
    ]);
  });

  it("coalesces overlapping sweeps into one run", async () => {
    await svc.provisionRunCheckpointBucket(PROJECT);
    const a = svc.requestAssistantRunCheckpointRetention();
    const b = svc.requestAssistantRunCheckpointRetention();
    expect(a).toBe(b);
    await a;
    const next = svc.requestAssistantRunCheckpointRetention();
    expect(next).not.toBe(a);
    await next;
  });

  it("gives isolated userData roots isolated stores", async () => {
    await startRun(PROJECT, "run-1", "w1");
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-run-checkpoint-other-"));
    try {
      userDataRoot.current = otherRoot;
      const other = await loadFresh();
      expect(await other.svc.discoverRuns(PROJECT)).toEqual([]);
    } finally {
      userDataRoot.current = tmpDir;
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });
});

describe("classification", () => {
  it("is unfinished until every writer has a valid terminal marker", async () => {
    const w1 = await startRun(PROJECT, "run-1", "w1");
    const w2 = await startRun(PROJECT, "run-1", "w2");
    await finish(w1);
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("unfinished");
    await finish(w2);
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("finished");
  });

  it.each([
    ["truncated JSON", '{"schemaVersion":1,"sta'],
    ["unknown schema version", '{"schemaVersion":2,"status":"completed"}'],
    ["wrong status", '{"schemaVersion":1,"status":"failed"}'],
    ["oversized", JSON.stringify({ schemaVersion: 1, status: "completed", pad: "x".repeat(8000) })],
    ["not an object", "null"],
  ])("does not treat a %s terminal marker as finished", async (_name, body) => {
    const w = await startRun(PROJECT, "run-1", "w1");
    await fs.writeFile(path.join(w, "done.json"), body);
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("unfinished");
  });

  it("ignores partly written temp files and corrupt checkpoint bodies", async () => {
    const w = await startRun(PROJECT, "run-1", "w1");
    await fs.writeFile(path.join(w, "checkpoint.json.abc.tmp"), '{"half');
    await fs.writeFile(path.join(w, "checkpoint.json"), "not json");
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("unfinished");
    await svc.runAssistantRunCheckpointRetention(Date.now() + 365 * DAY);
    expect(await exists(path.join(w, "checkpoint.json"))).toBe(true);
  });

  it("reports a freshly created run with no writers as unfinished", async () => {
    await svc.provisionRunCheckpointBucket(PROJECT);
    await fs.mkdir(path.join(svc.getRunCheckpointBucket(PROJECT), "run-1"));
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("unfinished");
  });

  it("skips symlinked and oddly named bucket entries instead of following them", async () => {
    const bucket = await svc.provisionRunCheckpointBucket(PROJECT);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-run-checkpoint-out-"));
    try {
      await fs.symlink(outside, path.join(bucket, "linked"), "dir");
      await fs.mkdir(path.join(bucket, "bad name"));
      await startRun(PROJECT, "run-1", "w1");
      expect((await svc.discoverRuns(PROJECT)).map((r) => [r.runId, r.state])).toEqual([
        ["run-1", "unfinished"],
      ]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("protects a run whose writers/ is a symlink to someone else's finished markers", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-run-checkpoint-out-"));
    try {
      const foreign = path.join(outside, "w-foreign");
      await finish(foreign, svc.FINISHED_RUN_MAX_AGE_MS + DAY);
      const runDir = path.join(svc.getRunCheckpointBucket(PROJECT), "run-1");
      await fs.mkdir(runDir, { recursive: true });
      await fs.symlink(outside, path.join(runDir, "writers"), "dir");

      expect((await svc.discoverRuns(PROJECT))[0].state).toBe("unreadable");
      await svc.runAssistantRunCheckpointRetention();
      expect(await exists(path.join(foreign, "done.json"))).toBe(true);
      expect(await exists(runDir)).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.each(["a symlink", "a directory"])("does not accept done.json that is %s", async (kind) => {
    const w = await startRun(PROJECT, "run-1", "w1");
    if (kind === "a directory") {
      await fs.mkdir(path.join(w, "done.json"));
    } else {
      const real = path.join(tmpDir, "real-done.json");
      await fs.writeFile(real, JSON.stringify({ schemaVersion: 1, status: "completed" }));
      await fs.symlink(real, path.join(w, "done.json"));
    }
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("unfinished");
  });

  it("protects a run with a stray file in writers/", async () => {
    const w = await startRun(PROJECT, "run-1", "w1");
    await finish(w, svc.FINISHED_RUN_MAX_AGE_MS + DAY);
    await fs.writeFile(path.join(w, "..", "stray"), "x");
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("unfinished");
    await svc.runAssistantRunCheckpointRetention();
    expect(await exists(w)).toBe(true);
  });
});

describe("retention", () => {
  it("removes finished runs past the age limit and keeps younger ones", async () => {
    const old = await startRun(PROJECT, "old", "w1");
    const fresh = await startRun(PROJECT, "fresh", "w1");
    await finish(old, svc.FINISHED_RUN_MAX_AGE_MS + DAY);
    await finish(fresh, DAY);

    const res = await svc.runAssistantRunCheckpointRetention();
    expect(res.prunedFinished).toBe(1);
    expect((await svc.discoverRuns(PROJECT)).map((r) => r.runId)).toEqual(["fresh"]);
  });

  it("keeps only the newest N finished runs", async () => {
    const total = svc.FINISHED_RUN_MAX_COUNT + 3;
    for (let i = 0; i < total; i++) {
      const w = await startRun(PROJECT, `run-${i}`, "w1");
      await finish(w, (total - i) * 1000);
    }
    const res = await svc.runAssistantRunCheckpointRetention();
    expect(res.prunedFinished).toBe(3);
    const left = (await svc.discoverRuns(PROJECT)).map((r) => r.runId);
    expect(left).toHaveLength(svc.FINISHED_RUN_MAX_COUNT);
    expect(left).not.toContain("run-0");
    expect(left).toContain(`run-${total - 1}`);
  });

  it("keeps a tombstone created between classification and removal", async () => {
    const w = await startRun(PROJECT, "run-1", "w1");
    await finish(w, svc.FINISHED_RUN_MAX_AGE_MS + DAY);
    const runDir = path.dirname(path.dirname(w));
    const realRm = fs.rm.bind(fs);
    const spy = vi.spyOn(fs, "rm").mockImplementation((async (target: string, opts: object) => {
      // A cancel lands just before the sweep deletes the payload.
      await fs.writeFile(path.join(runDir, "cancelled"), "{}");
      return realRm(target, opts);
    }) as unknown as typeof fs.rm);
    try {
      await svc.runAssistantRunCheckpointRetention();
    } finally {
      spy.mockRestore();
    }
    expect(await exists(path.join(runDir, "cancelled"))).toBe(true);
  });

  it("does not remove a run that gained an unfinished writer after it was classified", async () => {
    const w = await startRun(PROJECT, "run-1", "w1");
    await finish(w, svc.FINISHED_RUN_MAX_AGE_MS + DAY);
    const runDir = path.dirname(path.dirname(w));
    const realReaddir = fs.readdir.bind(fs);
    let discovered = false;
    const spy = vi.spyOn(fs, "readdir").mockImplementation((async (
      target: string,
      ...rest: unknown[]
    ) => {
      const out = await (realReaddir as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
      if (!discovered && target === path.join(runDir, "writers")) {
        discovered = true;
        await startRun(PROJECT, "run-1", "w-new");
      }
      return out;
    }) as unknown as typeof fs.readdir);
    try {
      await svc.runAssistantRunCheckpointRetention();
    } finally {
      spy.mockRestore();
    }
    expect(await exists(path.join(runDir, "writers", "w-new", "checkpoint.json"))).toBe(true);
  });

  it("orders pruning by the newest terminal marker and counts each bucket separately", async () => {
    const other = "c".repeat(64);
    const total = svc.FINISHED_RUN_MAX_COUNT + 2;
    for (let i = 0; i < total; i++) {
      const w = await startRun(PROJECT, `run-${i}`, "w1");
      await finish(w, (total - i) * 1000);
    }
    // An old-looking first writer must not make run-5 look old: the newest marker wins.
    const w2 = await startRun(PROJECT, "run-5", "w2");
    await finish(w2, 500);
    const otherWriter = await startRun(other, "only", "w1");
    await finish(otherWriter, 1000);

    await svc.runAssistantRunCheckpointRetention();
    const left = (await svc.discoverRuns(PROJECT)).map((r) => r.runId);
    expect(left).toHaveLength(svc.FINISHED_RUN_MAX_COUNT);
    expect(left).not.toContain("run-0");
    expect(left).not.toContain("run-1");
    expect(left).toContain("run-5");
    expect((await svc.discoverRuns(other)).map((r) => r.runId)).toEqual(["only"]);
  });

  it("applies the same rules to the global bucket", async () => {
    const g = svc.ASSISTANT_GLOBAL_CHECKPOINT_BUCKET;
    const old = await startRun(g, "old", "w1");
    await finish(old, svc.FINISHED_RUN_MAX_AGE_MS + DAY);
    await startRun(g, "live", "w1");
    await svc.discardRun(g, "gone");
    await svc.runAssistantRunCheckpointRetention();
    expect((await svc.discoverRuns(g)).map((r) => [r.runId, r.state]).sort()).toEqual([
      ["gone", "cancelled"],
      ["live", "unfinished"],
    ]);
  });

  it("logs error codes only, never paths", async () => {
    await startRun(PROJECT, "secret-run-name", "w1");
    const bucket = svc.getRunCheckpointBucket(PROJECT);
    const realReaddir = fs.readdir.bind(fs);
    const spy = vi
      .spyOn(fs, "readdir")
      .mockImplementation(((target: string, ...rest: unknown[]) =>
        target === bucket
          ? Promise.reject(Object.assign(new Error(`EACCES: ${bucket}`), { code: "EACCES" }))
          : (realReaddir as (...a: unknown[]) => unknown)(
              target,
              ...rest
            )) as unknown as typeof fs.readdir);
    try {
      await svc.runAssistantRunCheckpointRetention();
    } finally {
      spy.mockRestore();
    }
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain("EACCES");
    expect(logged).not.toContain(PROJECT);
    expect(logged).not.toContain(tmpDir);
  });

  it("never removes unfinished runs, however old", async () => {
    const w = await startRun(PROJECT, "stale", "w1");
    const t = new Date(Date.now() - 400 * DAY);
    await fs.utimes(path.join(w, "checkpoint.json"), t, t);
    const res = await svc.runAssistantRunCheckpointRetention(Date.now() + 400 * DAY);
    expect(res.prunedFinished).toBe(0);
    expect(await exists(path.join(w, "checkpoint.json"))).toBe(true);
  });

  it("keeps a run whose terminal markers are mixed with an unfinished writer", async () => {
    const w1 = await startRun(PROJECT, "mixed", "w1");
    await startRun(PROJECT, "mixed", "w2");
    await finish(w1, 400 * DAY);
    await svc.runAssistantRunCheckpointRetention();
    expect(await exists(w1)).toBe(true);
  });

  it("does not prune a bucket it cannot read, and counts the failure", async () => {
    const w = await startRun(PROJECT, "old", "w1");
    await finish(w, svc.FINISHED_RUN_MAX_AGE_MS + DAY);
    const bucket = svc.getRunCheckpointBucket(PROJECT);
    const realReaddir = fs.readdir.bind(fs);
    const spy = vi.spyOn(fs, "readdir").mockImplementation(((
      target: string,
      ...rest: unknown[]
    ) => {
      if (target === bucket) {
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      }
      return (realReaddir as (...a: unknown[]) => unknown)(target, ...rest);
    }) as unknown as typeof fs.readdir);
    try {
      const res = await svc.runAssistantRunCheckpointRetention();
      expect(res.failed).toBe(1);
      expect(res.prunedFinished).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(await exists(w)).toBe(true);
  });

  it("is a no-op with no root at all", async () => {
    expect(await svc.runAssistantRunCheckpointRetention()).toEqual({
      inspected: 0,
      prunedFinished: 0,
      prunedCancelledPayloads: 0,
      failed: 0,
    });
  });

  it("logs counts only, never run or project names", async () => {
    const w = await startRun(PROJECT, "secret-run-name", "w1");
    await finish(w, svc.FINISHED_RUN_MAX_AGE_MS + DAY);
    await svc.runAssistantRunCheckpointRetention();
    const logged = JSON.stringify([...logInfo.mock.calls, ...logError.mock.calls]);
    expect(logged).toContain("1 finished");
    expect(logged).not.toContain("secret-run-name");
    expect(logged).not.toContain(PROJECT);
  });
});

describe("cancellation and discard", () => {
  it("commits the tombstone, then removes payloads", async () => {
    const w = await startRun(PROJECT, "run-1", "w1");
    await svc.discardRun(PROJECT, "run-1");
    const runDir = path.dirname(path.dirname(w));
    expect(await exists(path.join(runDir, "cancelled"))).toBe(true);
    expect(await exists(path.join(runDir, "writers"))).toBe(false);
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("cancelled");
  });

  it("can tombstone a run that was never written, so a late notice finds a stop marker", async () => {
    await svc.discardRun(PROJECT, "ghost");
    expect(await svc.discoverRuns(PROJECT)).toEqual([
      expect.objectContaining({ runId: "ghost", state: "cancelled" }),
    ]);
  });

  it("is repeatable", async () => {
    await startRun(PROJECT, "run-1", "w1");
    await svc.discardRun(PROJECT, "run-1");
    await expect(svc.discardRun(PROJECT, "run-1")).resolves.toBeUndefined();
  });

  it("refuses to follow a symlinked run directory out of the bucket", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-run-checkpoint-out-"));
    try {
      await fs.mkdir(path.join(outside, "writers", "w1"), { recursive: true });
      await fs.writeFile(path.join(outside, "writers", "w1", "keep.txt"), "x");
      const bucket = await svc.provisionRunCheckpointBucket(PROJECT);
      await fs.symlink(outside, path.join(bucket, "run-1"), "dir");

      await expect(svc.discardRun(PROJECT, "run-1")).rejects.toThrow();
      expect(await exists(path.join(outside, "writers", "w1", "keep.txt"))).toBe(true);
      expect(await exists(path.join(outside, "cancelled"))).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("creates nothing outside the store when the bucket is a symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-run-checkpoint-out-"));
    try {
      await fs.mkdir(svc.getRunCheckpointRoot(), { recursive: true });
      await fs.symlink(outside, svc.getRunCheckpointBucket(PROJECT), "dir");
      await expect(svc.discardRun(PROJECT, "new-run")).rejects.toThrow();
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("leaves payloads in place when the tombstone cannot be written", async () => {
    const w = await startRun(PROJECT, "run-1", "w1");
    const runDir = path.dirname(path.dirname(w));
    await fs.mkdir(path.join(runDir, "cancelled")); // a directory blocks the atomic rename
    await expect(svc.discardRun(PROJECT, "run-1")).rejects.toThrow();
    expect(await exists(path.join(w, "checkpoint.json"))).toBe(true);
  });

  it("rejects unsafe run ids", async () => {
    await expect(svc.discardRun(PROJECT, "../x")).rejects.toThrow();
  });

  it("outranks every writer: a tombstone makes a run cancelled even beside a finished marker", async () => {
    const w = await startRun(PROJECT, "run-1", "w1");
    await finish(w);
    await writeAtomic(path.join(path.dirname(path.dirname(w)), "cancelled"), "");
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("cancelled");
  });

  it("treats an empty or malformed tombstone as a tombstone", async () => {
    const w = await startRun(PROJECT, "run-1", "w1");
    await fs.writeFile(path.join(path.dirname(path.dirname(w)), "cancelled"), "{bad");
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("cancelled");
  });

  it("clears old cancelled payloads but never the tombstone, however old", async () => {
    const w = await startRun(PROJECT, "run-1", "w1");
    await svc.discardRun(PROJECT, "run-1");
    await startRun(PROJECT, "run-1", "w-late"); // a late writer after cancellation
    const runDir = path.dirname(path.dirname(w));
    const t = new Date(Date.now() - 400 * DAY);
    await fs.utimes(path.join(runDir, "cancelled"), t, t);

    const res = await svc.runAssistantRunCheckpointRetention();
    expect(res.prunedCancelledPayloads).toBe(1);
    expect(await exists(path.join(runDir, "writers"))).toBe(false);

    await svc.runAssistantRunCheckpointRetention(Date.now() + 3650 * DAY);
    expect(await exists(path.join(runDir, "cancelled"))).toBe(true);
    expect((await svc.discoverRuns(PROJECT))[0].state).toBe("cancelled");
  });

  it("keeps recent cancelled payloads", async () => {
    const w = await startRun(PROJECT, "run-1", "w1");
    await svc.discardRun(PROJECT, "run-1");
    await startRun(PROJECT, "run-1", "w2");
    const res = await svc.runAssistantRunCheckpointRetention();
    expect(res.prunedCancelledPayloads).toBe(0);
    expect(await exists(path.join(path.dirname(path.dirname(w)), "writers", "w2"))).toBe(true);
  });
});

describe("launch-context addendum", () => {
  it("names both env vars, the layout and the no-replay rule, and no concrete path", () => {
    const text = svc.buildRunCheckpointAddendum();
    expect(text).toContain(svc.ASSISTANT_RUN_CHECKPOINT_ENV_VAR);
    expect(text).toContain(svc.ASSISTANT_RUN_CHECKPOINT_WRITER_ENV_VAR);
    expect(text).toContain("writers/<writerId>/checkpoint.json");
    expect(text).toContain("cancelled");
    expect(text).toContain("done.json");
    expect(text).toContain("permission to repeat a write");
    expect(text).not.toContain(tmpDir);
  });
});
