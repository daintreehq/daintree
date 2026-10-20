import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { CHANNELS } from "../../../channels.js";
import type { HandlerDependencies } from "../../../types.js";
import { registerArtifactHandlers } from "../artifacts.js";

// Real temp files, mocked git: each fake `git apply` reads the patch path it was
// handed, so a request that stages into a path another request also uses sees
// the wrong bytes (#13576).

const ipcMainMock = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: {},
}));

const execaMock = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: execaMock }));

vi.mock("../../../../utils/windowsExecutable.js", () => ({
  resolveExecutableForSpawn: vi.fn(async () => "git"),
}));

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

const FAKE_EVENT = { sender: { id: 1, getURL: () => "" } };

function patchFor(file: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    `-old-${file}`,
    `+new-${file}`,
    "",
  ].join("\n");
}

let tmpRoot: string;
let repoDir: string;
let cleanup: () => void;

function applyPatchHandler(): Handler {
  const call = ipcMainMock.handle.mock.calls.find((c) => c[0] === CHANNELS.ARTIFACT_APPLY_PATCH);
  if (!call) throw new Error("applyPatch handler not registered");
  return call[1] as Handler;
}

async function stagedEntries(): Promise<string[]> {
  return (await fs.readdir(tmpRoot)).filter((name) => name.startsWith("daintree-patch"));
}

beforeEach(async () => {
  vi.clearAllMocks();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "artifacts-apply-test-"));
  tmpRoot = path.join(base, "tmp");
  repoDir = path.join(base, "repo");
  await fs.mkdir(tmpRoot);
  await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
  vi.spyOn(os, "tmpdir").mockReturnValue(tmpRoot);
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  cleanup = registerArtifactHandlers({} as HandlerDependencies);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await fs.rm(path.dirname(tmpRoot), { recursive: true, force: true });
});

describe("artifacts applyPatch temp staging", () => {
  it("gives each concurrent request its own patch file within the same millisecond", async () => {
    const seen: string[] = [];
    let arrived = 0;
    let releaseAll!: () => void;
    const allArrived = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    execaMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (++arrived === 2) releaseAll();
      await allArrived;
      seen.push(await fs.readFile(args[1], "utf-8"));
      return { stdout: "", stderr: "" };
    });

    const handler = applyPatchHandler();
    const patchA = patchFor("a.txt");
    const patchB = patchFor("b.txt");
    const results = await Promise.all([
      handler(FAKE_EVENT, { patchContent: patchA, cwd: repoDir }),
      handler(FAKE_EVENT, { patchContent: patchB, cwd: repoDir }),
    ]);

    expect(seen.sort()).toEqual([patchA, patchB].sort());
    const [pathA, pathB] = execaMock.mock.calls.map((c) => (c[1] as string[])[1]);
    expect(pathA).not.toBe(pathB);
    expect(results).toEqual([{ modifiedFiles: ["a.txt"] }, { modifiedFiles: ["b.txt"] }]);
    expect(await stagedEntries()).toEqual([]);
  });

  it("removes the request's temp storage when git apply fails", async () => {
    execaMock.mockRejectedValue(new Error("patch does not apply"));

    await expect(
      applyPatchHandler()(FAKE_EVENT, { patchContent: patchFor("a.txt"), cwd: repoDir })
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(await stagedEntries()).toEqual([]);
  });

  it("rewrites the CRLF-stripped retry into the same request-owned file", async () => {
    const attempts: { file: string; content: string }[] = [];
    execaMock.mockImplementation(async (_cmd: string, args: string[]) => {
      attempts.push({ file: args[1], content: await fs.readFile(args[1], "utf-8") });
      if (attempts.length === 1) throw new Error("corrupt patch");
      return { stdout: "", stderr: "" };
    });
    const lfPatch = patchFor("a.txt");
    const crlfPatch = lfPatch.replace(/\n/g, "\r\n");

    const result = await applyPatchHandler()(FAKE_EVENT, { patchContent: crlfPatch, cwd: repoDir });

    expect(attempts.map((a) => a.content)).toEqual([crlfPatch, lfPatch]);
    expect(attempts[1].file).toBe(attempts[0].file);
    expect(result).toEqual({ modifiedFiles: ["a.txt"] });
    expect(await stagedEntries()).toEqual([]);
  });
});
