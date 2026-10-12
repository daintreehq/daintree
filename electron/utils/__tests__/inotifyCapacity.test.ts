import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workerEvents = vi.hoisted(() => ({ fake: null as null | ((source: string) => unknown) }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: function (this: unknown, source: string, options: unknown) {
      return workerEvents.fake
        ? workerEvents.fake(source)
        : new actual.Worker(source, options as never);
    },
  };
});

import { EventEmitter } from "node:events";
import { probeInotifyInstance } from "../inotifyCapacity.js";

describe("probeInotifyInstance", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "daintree-inotify-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("answers null when a watch can be opened", async () => {
    await expect(probeInotifyInstance(dir)).resolves.toBeNull();
  });

  it("leaves anything but a missing instance to the caller's own attempt", async () => {
    await expect(probeInotifyInstance(join(dir, "gone"))).resolves.toBeNull();
  });

  describe("answers only once the probe has let go of its instance", () => {
    afterEach(() => {
      workerEvents.fake = null;
    });

    it("waits for the worker to exit after a null", async () => {
      const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
      workerEvents.fake = () => worker;
      let answer: string | null | undefined;
      void probeInotifyInstance(dir).then((value) => (answer = value));

      worker.emit("message", null);
      await new Promise((resolve) => setImmediate(resolve));
      expect(worker.terminate).toHaveBeenCalled();
      expect(answer).toBeUndefined();

      worker.emit("exit", 1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(answer).toBeNull();
    });

    it.each(["EMFILE", "ENFILE", "ENOMEM"])("reports %s through the exit", async (code) => {
      const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
      workerEvents.fake = () => worker;
      const answer = probeInotifyInstance(dir);
      worker.emit("message", code);
      worker.emit("exit", 1);
      await expect(answer).resolves.toBe(code);
    });

    it("answers null when the worker dies without reporting", async () => {
      const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
      workerEvents.fake = () => worker;
      const answer = probeInotifyInstance(dir);
      worker.emit("error", new Error("worker crashed"));
      worker.emit("exit", 1);
      await expect(answer).resolves.toBeNull();
    });
  });
});
