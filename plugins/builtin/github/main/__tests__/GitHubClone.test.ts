import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import path from "node:path";

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("child_process", () => childProcessMock);

vi.mock("../GitHubRepoContext.js", () => ({
  parseGitHubRepoUrl: (url: string) => {
    const m = /^https?:\/\/github\.com\/([^/]+)\/([^/.]+)/i.exec(url);
    return m ? { owner: m[1], repo: m[2] } : null;
  },
}));

import { cloneCapability } from "../GitHubClone.js";

class FakeChildProcess extends EventEmitter {
  pid = 12345;
  stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout = new EventEmitter();
  kill = vi.fn();
  constructor() {
    super();
    this.stderr.setEncoding = vi.fn();
  }
}

function makeChild(opts: { closeCode?: number | null; emitImmediately?: boolean } = {}) {
  const child = new FakeChildProcess();
  const { closeCode = 0, emitImmediately = true } = opts;
  if (emitImmediately) {
    queueMicrotask(() => {
      child.emit("close", closeCode);
    });
  }
  return child;
}

function setAuthResult(err: Error | null) {
  childProcessMock.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      queueMicrotask(() => cb(err));
      return new FakeChildProcess();
    }
  );
}

const TARGET_DIR = path.join("/abs/parent", "repo");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GitHubClone — probeAuth", () => {
  it("reports authenticated when `gh auth status` exits clean", async () => {
    setAuthResult(null);
    await expect(cloneCapability.probeAuth()).resolves.toEqual({ authenticated: true });
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "gh",
      ["auth", "status"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function)
    );
  });

  it("reports unauthenticated when `gh auth status` fails", async () => {
    setAuthResult(new Error("not authed"));
    const probe = await cloneCapability.probeAuth();
    expect(probe.authenticated).toBe(false);
  });

  it("reports unauthenticated when gh is not on PATH (ENOENT)", async () => {
    setAuthResult(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
    const probe = await cloneCapability.probeAuth();
    expect(probe.authenticated).toBe(false);
  });

  it("reports unauthenticated without probing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = await cloneCapability.probeAuth(controller.signal);
    expect(probe.authenticated).toBe(false);
    expect(childProcessMock.execFile).not.toHaveBeenCalled();
  });
});

describe("GitHubClone — cloneRepository", () => {
  it("spawns `gh repo clone owner/repo <targetDir>` with the parent as cwd", async () => {
    let spawnedArgs: string[] | undefined;
    childProcessMock.spawn.mockImplementation((_cmd: string, args: string[]) => {
      spawnedArgs = args;
      return makeChild();
    });

    await cloneCapability.cloneRepository!("https://github.com/owner/repo", TARGET_DIR, {});

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["repo", "clone", "owner/repo"]),
      expect.objectContaining({ cwd: path.dirname(TARGET_DIR), windowsHide: true })
    );
    expect(spawnedArgs).toEqual(["repo", "clone", "owner/repo", TARGET_DIR]);
  });

  it("appends -- --depth 1 when shallow is true", async () => {
    let spawnedArgs: string[] | undefined;
    childProcessMock.spawn.mockImplementation((_cmd: string, args: string[]) => {
      spawnedArgs = args;
      return makeChild();
    });

    await cloneCapability.cloneRepository!("https://github.com/owner/repo", TARGET_DIR, {
      shallow: true,
    });

    expect(spawnedArgs).toEqual(["repo", "clone", "owner/repo", TARGET_DIR, "--", "--depth", "1"]);
  });

  it("relays the four stderr stage patterns through onProgress", async () => {
    childProcessMock.spawn.mockImplementation(() => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stderr.emit(
          "data",
          "Counting objects:  50% (5/10)\rCounting objects: 100% (10/10), done.\n" +
            "Compressing objects:  75% (3/4)\rCompressing objects: 100% (4/4), done.\n" +
            "Receiving objects:  50% (5/10)\rReceiving objects: 100% (10/10), done.\n" +
            "Resolving deltas: 100% (3/3), done.\n"
        );
        child.emit("close", 0);
      });
      return child;
    });

    const onProgress = vi.fn();
    await cloneCapability.cloneRepository!("https://github.com/owner/repo", TARGET_DIR, {
      onProgress,
    });

    const stages = onProgress.mock.calls.map((c) => c[0] as string);
    expect(stages).toContain("counting");
    expect(stages).toContain("compressing");
    expect(stages).toContain("receiving");
    expect(stages).toContain("resolving");
  });

  it("rejects with the exit code and stderr tail when gh exits non-zero", async () => {
    childProcessMock.spawn.mockImplementation(() => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stderr.emit("data", "fatal: repository not found\n");
        child.emit("close", 1);
      });
      return child;
    });

    await expect(
      cloneCapability.cloneRepository!("https://github.com/owner/repo", TARGET_DIR, {})
    ).rejects.toThrow(/exited with code 1.*repository not found/);
  });

  it("rejects without spawning for an unrecognized GitHub URL", async () => {
    await expect(
      cloneCapability.cloneRepository!("https://github.com/owner", TARGET_DIR, {})
    ).rejects.toThrow(/Unrecognized GitHub repository URL/);
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it("kills the clone and rejects as cancelled when the signal aborts", async () => {
    let capturedChild: FakeChildProcess | undefined;
    childProcessMock.spawn.mockImplementation(() => {
      capturedChild = new FakeChildProcess();
      return capturedChild;
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const controller = new AbortController();
    const clonePromise = cloneCapability.cloneRepository!(
      "https://github.com/owner/repo",
      TARGET_DIR,
      { signal: controller.signal }
    );

    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    capturedChild?.emit("close", null);

    await expect(clonePromise).rejects.toThrow(/Clone cancelled/);
    if (process.platform === "win32") {
      expect(childProcessMock.spawnSync).toHaveBeenCalledWith(
        "taskkill",
        expect.arrayContaining(["/F", "/T", "/PID"]),
        expect.objectContaining({ windowsHide: true })
      );
    } else {
      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
    }
    killSpy.mockRestore();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      cloneCapability.cloneRepository!("https://github.com/owner/repo", TARGET_DIR, {
        signal: controller.signal,
      })
    ).rejects.toThrow(/Clone cancelled/);
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });
});
