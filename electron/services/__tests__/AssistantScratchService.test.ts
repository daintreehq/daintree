import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import { PathLike } from "fs";
import os from "os";
import path from "path";

// Mock electron `app.getPath('userData')` to a per-test temp dir so the
// service's `getAssistantScratchRoot()` resolves under it. The module pins
// `instanceId` at import time, so we import after the mock is set up.
const userDataRoot = { current: "" };

vi.mock("electron", () => ({
  app: {
    getPath: (key: string) => {
      if (key === "userData") return userDataRoot.current;
      throw new Error(`unexpected getPath: ${key}`);
    },
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

let runAssistantScratchCleanup: typeof import("../AssistantScratchService.js").runAssistantScratchCleanup;
let startAssistantScratchCleanup: typeof import("../AssistantScratchService.js").startAssistantScratchCleanup;
let getAssistantScratchRoot: typeof import("../AssistantScratchService.js").getAssistantScratchRoot;
let getScratchDirForSession: typeof import("../AssistantScratchService.js").getScratchDirForSession;
let getAssistantScratchInstanceId: typeof import("../AssistantScratchService.js").getAssistantScratchInstanceId;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-scratch-test-"));
  userDataRoot.current = tmpDir;
  vi.resetModules();
  const mod = await import("../AssistantScratchService.js");
  runAssistantScratchCleanup = mod.runAssistantScratchCleanup;
  startAssistantScratchCleanup = mod.startAssistantScratchCleanup;
  getAssistantScratchRoot = mod.getAssistantScratchRoot;
  getScratchDirForSession = mod.getScratchDirForSession;
  getAssistantScratchInstanceId = mod.getAssistantScratchInstanceId;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("AssistantScratchService paths", () => {
  it("places each session subdir under the current instance", () => {
    const instanceId = getAssistantScratchInstanceId();
    expect(getScratchDirForSession("session-a")).toBe(
      path.join(tmpDir, "assistant-scratch", instanceId, "session-a")
    );
  });

  it("uses a stable instance id across calls within a process", () => {
    const a = getAssistantScratchInstanceId();
    const b = getAssistantScratchInstanceId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("runAssistantScratchCleanup", () => {
  it("returns zero candidates when the root does not exist", async () => {
    const result = await runAssistantScratchCleanup();
    expect(result.candidates).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("removes prior-instance subdirs but keeps the current one", async () => {
    const root = getAssistantScratchRoot();
    const instanceId = getAssistantScratchInstanceId();
    await fs.mkdir(path.join(root, instanceId), { recursive: true });
    const stale1 = path.join(root, "11111111-1111-4111-8111-111111111111");
    const stale2 = path.join(root, "22222222-2222-4222-8222-222222222222");
    await fs.mkdir(stale1, { recursive: true });
    await fs.mkdir(stale2, { recursive: true });
    await fs.writeFile(path.join(stale1, "scratch.txt"), "old work");

    const result = await runAssistantScratchCleanup();

    expect(result.candidates).toBe(3);
    expect(result.removed).toBe(2);
    expect(result.failed).toBe(0);
    await expect(fs.access(path.join(root, instanceId))).resolves.toBeUndefined();
    await expect(fs.access(stale1)).rejects.toBeDefined();
    await expect(fs.access(stale2)).rejects.toBeDefined();
  });

  it("removes loose files at the root that aren't the current instance", async () => {
    const root = getAssistantScratchRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "stray-file"), "not a dir");

    const result = await runAssistantScratchCleanup();

    expect(result.candidates).toBe(1);
    expect(result.removed).toBe(1);
    await expect(fs.access(path.join(root, "stray-file"))).rejects.toBeDefined();
  });

  it("logs and reports per-entry failures without throwing", async () => {
    const root = getAssistantScratchRoot();
    const instanceId = getAssistantScratchInstanceId();
    await fs.mkdir(path.join(root, instanceId), { recursive: true });
    const stale = path.join(root, "ffffffff-ffff-4fff-8fff-ffffffffffff");
    await fs.mkdir(stale, { recursive: true });

    const originalRm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target: PathLike, options) => {
      if (typeof target === "string" && target === stale) {
        const err = new Error("EBUSY") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      return originalRm(target, options);
    });

    try {
      const result = await runAssistantScratchCleanup();
      expect(result.failed).toBe(1);
      expect(result.removed).toBe(0);
    } finally {
      rmSpy.mockRestore();
    }
  });
});

describe("startAssistantScratchCleanup", () => {
  it("creates the current-instance dir even when nothing exists yet", async () => {
    await startAssistantScratchCleanup();
    const root = getAssistantScratchRoot();
    const instanceId = getAssistantScratchInstanceId();
    await expect(fs.access(path.join(root, instanceId))).resolves.toBeUndefined();
  });

  it("does not throw on cleanup errors", async () => {
    const root = getAssistantScratchRoot();
    await fs.mkdir(root, { recursive: true });
    const spy = vi.spyOn(fs, "readdir").mockImplementation(async () => {
      throw new Error("boom");
    });
    try {
      await expect(startAssistantScratchCleanup()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
