import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { closeSync, constants as fsConstants, openSync } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { RunCommandDetector } from "../RunCommandDetector.js";

// A FIFO's open() blocks its libuv worker until a writer appears, the same way
// a read of an online-only File Provider placeholder blocks until the provider
// downloads it, so these tests pin real pool threads (#16361).
const FIFO_INPUTS = [
  "package.json",
  "Makefile",
  "justfile",
  "Taskfile.yml",
  "Procfile",
  "mise.toml",
  "composer.json",
  path.join(".devcontainer", "devcontainer.json"),
];

/** Lets every reader blocked in open() see EOF; returns how many there were. */
function releaseBlockedReaders(fifos: string[]): number {
  let released = 0;
  for (const fifo of fifos) {
    try {
      // Succeeds only while a reader is blocked in open().
      closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
      released++;
    } catch {
      // ENXIO: nobody is reading this one right now.
    }
  }
  return released;
}

async function drain(fifos: string[], pending: Promise<unknown>): Promise<void> {
  let settled = false;
  void pending.finally(() => {
    settled = true;
  });
  const deadline = Date.now() + 10_000;
  while (!settled && Date.now() < deadline) {
    releaseBlockedReaders(fifos);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a reader to block on one of the FIFOs and opens it for writing
 * without writing: the reader's open() returns and its read() then waits on
 * this descriptor, so its worker stays pinned until the caller closes it.
 */
async function pinBlockedReader(
  fifos: string[],
  timeoutMs: number
): Promise<{ fifo: string; fd: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const fifo of fifos) {
      try {
        return { fifo, fd: openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK) };
      } catch {
        // ENXIO: no reader on this one yet.
      }
    }
    await sleep(5);
  }
  throw new Error("no read ever blocked on the project's files");
}

describe.skipIf(process.platform === "win32")(
  "RunCommandDetector with reads that never finish",
  () => {
    let tempDir: string;
    let projectRoot: string;
    let fifos: string[];
    let pending: Promise<unknown>[];

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-run-cmd-fifo-"));
      projectRoot = path.join(tempDir, "project");
      await fs.mkdir(path.join(projectRoot, ".devcontainer"), { recursive: true });
      fifos = FIFO_INPUTS.map((name) => path.join(projectRoot, name));
      for (const fifo of fifos) execFileSync("mkfifo", [fifo]);
      pending = [];
    });

    afterEach(async () => {
      await drain(fifos, Promise.allSettled(pending));
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("holds one worker for the hung project and leaves Main's other file I/O free", async () => {
      const unrelated = path.join(tempDir, "unrelated.txt");
      await fs.writeFile(unrelated, "still readable", "utf-8");
      const healthyRoot = path.join(tempDir, "healthy");
      await fs.mkdir(healthyRoot);
      await fs.writeFile(
        path.join(healthyRoot, "package.json"),
        JSON.stringify({ name: "healthy", scripts: { dev: "vite" } }),
        "utf-8"
      );

      const detector = new RunCommandDetector();
      const detection = detector.detect(projectRoot);
      pending.push(detection);
      const pinned = await pinBlockedReader(fifos, 5_000);
      try {
        // A worker is held by the project's read for everything below.
        const [text, stats, , real] = await within(
          2_000,
          Promise.all([
            fs.readFile(unrelated, "utf-8"),
            fs.stat(unrelated),
            fs.access(unrelated),
            fs.realpath(unrelated),
          ])
        );
        expect(text).toBe("still readable");
        expect(stats.isFile()).toBe(true);
        expect(path.basename(real)).toBe("unrelated.txt");

        const healthy = await within(2_000, new RunCommandDetector().detect(healthyRoot));
        expect(healthy.map((cmd) => cmd.command)).toEqual(["npm run dev"]);

        // The hung project reads as nothing detected rather than an endless wait.
        expect(await within(5_000, detection)).toEqual([]);
        // Asking again while the read is still stuck fails fast, and no second
        // read ever blocks on the project's other files.
        expect(await within(1_000, detector.detect(projectRoot))).toEqual([]);
        expect(releaseBlockedReaders(fifos.filter((fifo) => fifo !== pinned.fifo))).toBe(0);
      } finally {
        closeSync(pinned.fd);
      }
    });
  }
);
