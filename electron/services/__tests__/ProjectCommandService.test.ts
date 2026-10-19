import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";

const spawnMock = vi.fn<(command: string, options: Record<string, unknown>) => unknown>();
const treeKillMock = vi.fn<(target: unknown, options: { timeoutMs?: number }) => unknown>();
const bgTreeKillMock =
  vi.fn<(target: unknown, tag: string, options: { timeoutMs?: number }) => Promise<null>>();
const realpathMock = vi.fn<(target: string) => Promise<string>>();
const listWorktreesMock = vi.fn<() => Promise<Array<{ path: string; bare: boolean }>>>();
const installEnvMock = vi.fn<() => Record<string, string>>();

vi.mock("child_process", () => ({
  spawn: (command: string, options: Record<string, unknown>) => spawnMock(command, options),
}));

vi.mock("../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTreeSync: (target: unknown, options: { timeoutMs?: number }) =>
    treeKillMock(target, options),
  killWindowsProcessTreeInBackground: (
    target: unknown,
    tag: string,
    options: { timeoutMs?: number }
  ) => bgTreeKillMock(target, tag, options),
}));

vi.mock("fs/promises", () => ({
  realpath: (target: string) => realpathMock(target),
}));

vi.mock("../GitService.js", () => ({
  GitService: class {
    listWorktrees() {
      return listWorktreesMock();
    }
  },
}));

vi.mock("../../utils/spawnEnv.js", () => ({
  buildInstallEnv: () => installEnvMock(),
}));

const { ProjectCommandService, ProjectCommandError, buildProjectCommandEnv } =
  await import("../ProjectCommandService.js");
const { PROJECT_COMMAND_MAX_CONCURRENT } = await import("../../../shared/types/projectCommand.js");

const IS_WIN = process.platform === "win32";

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  pid: number | undefined = 4242;
  kill = vi.fn();
  unref = vi.fn();

  finish(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

let children: FakeChild[];

function makeService(
  layers: { global: Record<string, string>; project: Record<string, string> } = {
    global: {},
    project: {},
  }
) {
  return new ProjectCommandService({
    getProject: async (id) => (id === "proj-1" ? { id, path: "/repo" } : null),
    getEnvLayers: async () => layers,
  });
}

function lastSpawnEnv(): Record<string, string> {
  const call = spawnMock.mock.calls.at(-1);
  return (call?.[1]?.env ?? {}) as Record<string, string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  children = [];
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  realpathMock.mockImplementation(async (p: string) => p);
  listWorktreesMock.mockResolvedValue([{ path: "/repo-wt", bare: false }]);
  installEnvMock.mockReturnValue({ PATH: "/usr/bin", HOME: "/home/u", TERM: "dumb" });
  treeKillMock.mockReturnValue({
    mode: "tree",
    targeted: [],
    killed: [],
    alreadyGone: [],
    timedOut: [],
    unconfirmed: [],
    failed: [],
    identityMismatch: [],
    stale: [],
    rootEnded: true,
  });
  bgTreeKillMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectCommandService.run", () => {
  it("runs the command as given in the project root and reports how it ended", async () => {
    const service = makeService();
    const promise = service.run({ projectId: "proj-1", command: "git status --short" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    children[0]!.stdout.push(" M src/app.ts\n");
    children[0]!.finish(0);

    const result = await promise;
    expect(spawnMock.mock.calls[0]?.[0]).toBe("git status --short");
    expect(spawnMock.mock.calls[0]?.[1]).toMatchObject({ cwd: "/repo", shell: true });
    expect(result).toMatchObject({
      projectId: "proj-1",
      cwd: "/repo",
      exitCode: 0,
      timedOut: false,
      aborted: false,
      outputTruncated: false,
    });
    expect(result.output).toContain("M src/app.ts");
  });

  it("returns a non-zero exit as a result", async () => {
    const service = makeService();
    const promise = service.run({ projectId: "proj-1", command: "npm test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    children[0]!.finish(1);

    await expect(promise).resolves.toMatchObject({ exitCode: 1 });
  });

  it("starts in a registered worktree and refuses any other directory", async () => {
    const service = makeService();
    const inWorktree = service.run({ projectId: "proj-1", command: "ls", cwd: "/repo-wt" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    children[0]!.finish(0);
    await expect(inWorktree).resolves.toMatchObject({ cwd: "/repo-wt" });

    await expect(
      service.run({ projectId: "proj-1", command: "ls", cwd: "/elsewhere" })
    ).rejects.toBeInstanceOf(ProjectCommandError);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown project before anything runs", async () => {
    const service = makeService();
    await expect(service.run({ projectId: "nope", command: "ls" })).rejects.toThrow(
      /No project found/
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("asks its caller once more after resolving the project, and spawns nothing when refused (#13493)", async () => {
    let resolved = false;
    const service = new ProjectCommandService({
      getProject: async (id) => ({ id, path: "/repo" }),
      getEnvLayers: async () => {
        resolved = true;
        return { global: {}, project: {} };
      },
    });
    const authorize = vi.fn(() => {
      // Asked only once everything it waited on is done.
      expect(resolved).toBe(true);
      throw new Error("another machine has control now");
    });

    await expect(
      service.run({ projectId: "proj-1", command: "git status" }, { authorize })
    ).rejects.toThrow("another machine has control now");
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("lets several commands share a directory and refuses past the host-wide bound", async () => {
    const service = makeService();
    const running = Array.from({ length: PROJECT_COMMAND_MAX_CONCURRENT }, () =>
      service.run({ projectId: "proj-1", command: "sleep 5" })
    );
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(PROJECT_COMMAND_MAX_CONCURRENT));

    await expect(service.run({ projectId: "proj-1", command: "git status" })).rejects.toThrow(
      /already running/
    );

    for (const child of children) child.finish(0);
    await Promise.all(running);

    // A slot frees as soon as its run settles.
    const next = service.run({ projectId: "proj-1", command: "git status" });
    await vi.waitFor(() =>
      expect(spawnMock).toHaveBeenCalledTimes(PROJECT_COMMAND_MAX_CONCURRENT + 1)
    );
    children.at(-1)!.finish(0);
    await expect(next).resolves.toMatchObject({ exitCode: 0 });
  });

  it.skipIf(IS_WIN)("kills the process group when the deadline passes", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const service = makeService();
      const promise = service.run({ projectId: "proj-1", command: "sleep 600", timeoutMs: 1_000 });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

      await vi.advanceTimersByTimeAsync(1_000);
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");

      children[0]!.finish(null, "SIGTERM");
      await expect(promise).resolves.toMatchObject({ timedOut: true, exitCode: null });
    } finally {
      killSpy.mockRestore();
    }
  });

  it.each(["darwin", "win32"] as const)(
    "reports a cancelled run as aborted on %s",
    async (platform) => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        const service = makeService();
        const controller = new AbortController();
        const promise = service.run(
          { projectId: "proj-1", command: "sleep 600" },
          { signal: controller.signal }
        );
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

        controller.abort();
        if (platform === "win32") {
          expect(bgTreeKillMock).toHaveBeenCalledExactlyOnceWith(
            { pid: children[0]!.pid, ownChild: children[0] },
            "[ProjectCommandService]",
            { timeoutMs: 3_000 }
          );
          expect(treeKillMock).not.toHaveBeenCalled();
        } else {
          expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
        }
        children[0]!.finish(null, "SIGTERM");

        await expect(promise).resolves.toMatchObject({ aborted: true, timedOut: false });
        expect(spawnMock).toHaveBeenCalledTimes(1);
      } finally {
        killSpy.mockRestore();
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  );

  it.each(["darwin", "win32"] as const)(
    "stops what is running on dispose and starts nothing after on %s",
    async (platform) => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        const service = makeService();
        const promise = service.run({ projectId: "proj-1", command: "sleep 600" });
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

        service.dispose();
        if (platform === "win32") {
          expect(treeKillMock).toHaveBeenCalledExactlyOnceWith(
            { pid: children[0]!.pid, ownChild: children[0] },
            { timeoutMs: 3_000 }
          );
          expect(bgTreeKillMock).not.toHaveBeenCalled();
        } else {
          expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
        }
        children[0]!.finish(null, "SIGKILL");

        await expect(promise).resolves.toMatchObject({ aborted: true });
        await expect(service.run({ projectId: "proj-1", command: "ls" })).rejects.toThrow(
          /shutting down/
        );
        expect(spawnMock).toHaveBeenCalledTimes(1);
      } finally {
        killSpy.mockRestore();
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  );
});

describe("buildProjectCommandEnv", () => {
  it("never hands a command Daintree's own credentials, wherever they came from", () => {
    installEnvMock.mockReturnValue({
      PATH: "/usr/bin",
      DAINTREE_MCP_TOKEN: "bearer-from-allowlist",
    });
    const env = buildProjectCommandEnv(
      { global: { DAINTREE_GITHUB_TOKEN: "user-set" }, project: { daintree_plugin_x: "y" } },
      {}
    );

    expect(Object.keys(env).filter((key) => key.toUpperCase().startsWith("DAINTREE_"))).toEqual([]);
  });

  it("keeps the user's configured variables and drops code-injecting ones", () => {
    const env = buildProjectCommandEnv(
      {
        global: { GLOBAL_FLAG: "1", NODE_OPTIONS: "--require /tmp/x.js" },
        project: { DATABASE_URL: "postgres://localhost/test", DYLD_INSERT_LIBRARIES: "/x" },
      },
      {}
    );

    expect(env.GLOBAL_FLAG).toBe("1");
    expect(env.DATABASE_URL).toBe("postgres://localhost/test");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
  });

  it("passes the SSH agent socket through but nothing else from the ambient environment", () => {
    const env = buildProjectCommandEnv(null, {
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GH_TOKEN: "ghp_ambient",
      OPENAI_API_KEY: "sk-ambient",
    });

    expect(env.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("forces non-interactive behaviour over anything a layer set", () => {
    const env = buildProjectCommandEnv(
      { global: {}, project: { GIT_TERMINAL_PROMPT: "1", PAGER: "less" } },
      {}
    );

    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.PAGER).toBe("cat");
    expect(env.GH_PROMPT_DISABLED).toBe("1");
  });

  it("lets a later layer win over every spelling of a name on Windows", () => {
    installEnvMock.mockReturnValue({ Path: "C:\\Windows", TERM: "dumb" });
    const env = buildProjectCommandEnv(
      { global: {}, project: { PATH: "C:\\tools;C:\\Windows" } },
      {},
      "win32"
    );

    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(env.PATH).toBe("C:\\tools;C:\\Windows");
  });

  it("keeps distinct spellings apart where names are case-sensitive", () => {
    installEnvMock.mockReturnValue({ PATH: "/usr/bin" });
    const env = buildProjectCommandEnv({ global: {}, project: { Path: "/other" } }, {}, "linux");

    expect(env.PATH).toBe("/usr/bin");
    expect(env.Path).toBe("/other");
  });

  it("reports an environment it cannot build as a failure to start", async () => {
    installEnvMock.mockImplementation(() => {
      throw new Error("no home directory");
    });
    const service = makeService();

    await expect(service.run({ projectId: "proj-1", command: "ls" })).rejects.toThrow(
      /Failed to start "command": no home directory/
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("is the environment a run is spawned with", async () => {
    const service = makeService({ global: {}, project: { PROJECT_ONLY: "yes" } });
    const promise = service.run({ projectId: "proj-1", command: "env" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    children[0]!.finish(0);
    await promise;

    expect(lastSpawnEnv().PROJECT_ONLY).toBe("yes");
    expect(lastSpawnEnv().CI).toBe("1");
  });
});
