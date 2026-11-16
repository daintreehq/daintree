import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorktreeLifecycleStatus } from "../../../shared/types/worktree.js";
import { stubProcessKillForFile } from "../../__tests__/helpers/processKillGuard.js";

const n = (p: string) => p.replace(/\\/g, "/");

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn(),
  cp: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../utils/fs.js", () => ({
  resilientAtomicWriteFile: vi.fn().mockResolvedValue(undefined),
}));

const approveEverything: import("../lifecycleCommandTrust.js").LifecycleCommandApprovalStore = {
  isApproved: async () => true,
  approve: async () => {},
};

/** A command the test prints from and ends by hand. */
function controlledChild() {
  const onData: ((chunk: Buffer) => void)[] = [];
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const child = {
    pid: 4321,
    stdout: {
      on: (event: string, cb: (chunk: Buffer) => void) => {
        if (event === "data") onData.push(cb);
      },
    },
    stderr: { on: vi.fn() },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(cb);
    },
    kill: vi.fn(),
  };
  return {
    child: child as never,
    print: (text: string) => onData.forEach((cb) => cb(Buffer.from(text))),
    exit: (code = 0) => listeners.close?.forEach((cb) => cb(code, null)),
  };
}

describe("WorktreeLifecycleService live output (#17115)", () => {
  // The controlled child's process group 4321 is made up; the timeout and
  // abort paths signal it.
  stubProcessKillForFile();

  let service: import("../WorktreeLifecycleService.js").WorktreeLifecycleService;
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockAccess: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fsModule = await import("fs/promises");
    mockAccess = vi.mocked(fsModule.access);
    mockReadFile = vi.mocked(fsModule.readFile);
    mockSpawn = vi.mocked((await import("child_process")).spawn);
    const { WorktreeLifecycleService } = await import("../WorktreeLifecycleService.js");
    // After every import: a frozen clock stalls a loader that resolves through a timer.
    vi.useFakeTimers();
    service = new WorktreeLifecycleService("/home/testuser", approveEverything);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start(onOutput: (output: string) => void, commands = ["node link.mjs"]) {
    return service.runCommands(commands, { cwd: "/wt", env: {}, onProgress: vi.fn(), onOutput });
  }

  describe("runCommands onOutput", () => {
    it("reports what a command has printed before it exits, once per interval however much arrives", async () => {
      const run = controlledChild();
      mockSpawn.mockReturnValue(run.child);
      const onOutput = vi.fn();
      const done = start(onOutput);

      run.print("Shared node_modules is behind package-lock.json.\n");
      await vi.advanceTimersByTimeAsync(200);
      run.print("Refreshing it with npm ci in /main (log: /tmp/ci.log)\n");
      await vi.advanceTimersByTimeAsync(299);
      expect(onOutput).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onOutput).toHaveBeenCalledTimes(1);
      expect(onOutput).toHaveBeenLastCalledWith(
        "Shared node_modules is behind package-lock.json.\nRefreshing it with npm ci in /main (log: /tmp/ci.log)\n"
      );

      run.print("added 1200 packages\n");
      await vi.advanceTimersByTimeAsync(500);
      expect(onOutput).toHaveBeenCalledTimes(2);
      expect(onOutput.mock.lastCall?.[0]).toMatch(/added 1200 packages\n$/);

      run.exit(0);
      await done;
    });

    it("never reports once the run has settled, even with output still waiting to go out", async () => {
      const run = controlledChild();
      mockSpawn.mockReturnValue(run.child);
      const onOutput = vi.fn();
      const done = start(onOutput);

      run.print("last words\n");
      run.exit(0);
      const result = await done;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(onOutput).not.toHaveBeenCalled();
      expect(result.output).toBe("last words\n");
    });

    it("stops reporting before the run's log is written, not only once it has been", async () => {
      const fsUtils = await import("../../utils/fs.js");
      let finishWrite: () => void = () => {};
      vi.mocked(fsUtils.resilientAtomicWriteFile).mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishWrite = resolve))
      );
      const run = controlledChild();
      mockSpawn.mockReturnValue(run.child);
      const onOutput = vi.fn();
      const done = service.runCommands(["./teardown.sh"], {
        cwd: "/wt",
        env: {},
        onProgress: vi.fn(),
        onOutput,
        logDir: "/logs/wt-1",
      });

      run.print("removing volumes\n");
      run.exit(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onOutput).not.toHaveBeenCalled();

      finishWrite();
      await done;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onOutput).not.toHaveBeenCalled();
    });

    it("never reports after a failed, timed-out or aborted command", async () => {
      for (const ending of ["fail", "timeout", "abort"] as const) {
        const run = controlledChild();
        mockSpawn.mockReturnValue(run.child);
        const onOutput = vi.fn();
        const abort = new AbortController();
        const done = service.runCommands(["./step.sh"], {
          cwd: "/wt",
          env: {},
          onProgress: vi.fn(),
          onOutput,
          signal: abort.signal,
          timeoutMs: 10_000,
        });

        run.print("working\n");
        if (ending === "fail") run.exit(1);
        if (ending === "abort") {
          abort.abort();
          run.exit(1);
        }
        if (ending === "timeout") {
          await vi.advanceTimersByTimeAsync(10_000);
          run.exit(1);
        }
        await done;
        const calls = onOutput.mock.calls.length;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(onOutput.mock.calls.length, ending).toBe(calls);
      }
    });

    it("holds a line back until it ends, so a token printed in pieces is only ever shown scrubbed", async () => {
      const run = controlledChild();
      mockSpawn.mockReturnValue(run.child);
      const onOutput = vi.fn();
      const done = start(onOutput);
      const token = `ghp_${"a".repeat(36)}`;

      run.print("checking\n");
      run.print(`token=${token.slice(0, 12)}`);
      await vi.advanceTimersByTimeAsync(500);
      expect(onOutput).toHaveBeenLastCalledWith("checking\n");

      run.print(`${token.slice(12)}\n`);
      await vi.advanceTimersByTimeAsync(500);
      expect(onOutput).toHaveBeenLastCalledWith("checking\ntoken=[REDACTED]\n");
      for (const [output] of onOutput.mock.calls) expect(output).not.toContain("ghp_");

      run.exit(0);
      await done;
    });

    it("holds a key block back until its END line is in", async () => {
      const run = controlledChild();
      mockSpawn.mockReturnValue(run.child);
      const onOutput = vi.fn();
      const done = start(onOutput);

      run.print("before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretbody\n");
      await vi.advanceTimersByTimeAsync(500);
      expect(onOutput).toHaveBeenLastCalledWith("before\n");

      run.print("-----END RSA PRIVATE KEY-----\nafter\n");
      await vi.advanceTimersByTimeAsync(500);
      const shown = onOutput.mock.lastCall?.[0] as string;
      expect(shown).toContain("after\n");
      expect(shown).not.toContain("secretbody");

      run.exit(0);
      await done;
    });

    it("says nothing when no new line has finished since the last report", async () => {
      const run = controlledChild();
      mockSpawn.mockReturnValue(run.child);
      const onOutput = vi.fn();
      const done = start(onOutput);

      run.print("step 1\n");
      await vi.advanceTimersByTimeAsync(500);
      run.print("step 2 is still");
      await vi.advanceTimersByTimeAsync(500);

      expect(onOutput).toHaveBeenCalledTimes(1);
      run.exit(0);
      await done;
    });

    it("keeps one tail across the run's commands", async () => {
      const runs = [controlledChild(), controlledChild()];
      mockSpawn.mockReturnValueOnce(runs[0].child).mockReturnValueOnce(runs[1].child);
      const onOutput = vi.fn();
      const done = start(onOutput, ["first", "second"]);

      runs[0].print("one\n");
      runs[0].exit(0);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      runs[1].print("two\n");
      await vi.advanceTimersByTimeAsync(500);
      expect(onOutput).toHaveBeenLastCalledWith("one\ntwo\n");

      runs[1].exit(0);
      await done;
    });
  });

  it("says earlier output was left out once the run has printed more than it shows", async () => {
    const run = controlledChild();
    mockSpawn.mockReturnValue(run.child);
    const onOutput = vi.fn();
    const done = start(onOutput);

    run.print(`${"line of build output\n".repeat(1_000)}done\n`);
    await vi.advanceTimersByTimeAsync(500);
    const shown = onOutput.mock.lastCall?.[0] as string;
    expect(shown.startsWith("...(earlier output omitted)\n")).toBe(true);
    expect(shown.endsWith("done\n")).toBe(true);

    run.exit(0);
    await done;
  });

  it("drops the line the scrub window starts inside, even when the window has no line break", async () => {
    const run = controlledChild();
    mockSpawn.mockReturnValue(run.child);
    const token = `ghp_${"A".repeat(36)}`;
    // One line: the window starts inside the token, and scrubbing the Bearer
    // values after it shrinks the rest below the 8 KiB tail, which would bring
    // the token's unrecognisable remainder into view.
    const line = `prefix ${token} ${`Bearer ${"B".repeat(4000)} `.repeat(16)}${"~".repeat(1387)}`;
    const done = service.runCommands(["./run.sh"], { cwd: "/wt", env: {}, onProgress: vi.fn() });

    run.print(line);
    run.exit(0);
    const { output } = await done;

    expect(output).not.toContain("A".repeat(10));
  });

  it("drops the rest of a key block whose BEGIN line the scrub window left out", async () => {
    const run = controlledChild();
    mockSpawn.mockReturnValue(run.child);
    const body = `${"S".repeat(63)}\n`.repeat(1_100);
    const done = service.runCommands(["./run.sh"], { cwd: "/wt", env: {}, onProgress: vi.fn() });

    run.print(`-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\ncerts written\n`);
    run.exit(0);
    const { output } = await done;

    expect(output).not.toContain("SSSS");
    expect(output.endsWith("certs written\n")).toBe(true);
  });

  it("treats a key block's BEGIN line the window's start cuts through as the block it opens", async () => {
    // 65,540 characters: the window's last 65,536 start inside "-----BEGIN ".
    const block = `-----BEGIN PRIVATE KEY-----\n${`${"S".repeat(63)}\n`.repeat(1_023)}-----END PRIVATE KEY-----\ncerts written\n`;
    for (const live of [false, true]) {
      const run = controlledChild();
      mockSpawn.mockReturnValue(run.child);
      const onOutput = vi.fn();
      const done = service.runCommands(["./run.sh"], {
        cwd: "/wt",
        env: {},
        onProgress: vi.fn(),
        onOutput,
      });

      run.print(block);
      if (live) await vi.advanceTimersByTimeAsync(500);
      run.exit(0);
      const { output } = await done;
      const shown = live ? (onOutput.mock.lastCall?.[0] as string) : output;

      expect(shown, live ? "live" : "final").not.toContain("SSSS");
      expect(shown.endsWith("certs written\n")).toBe(true);
    }
  });

  it("scrubs the output before cutting it to the tail, so a cut through a token shows none of it", async () => {
    const run = controlledChild();
    mockSpawn.mockReturnValue(run.child);
    const token = `ghp_${"b".repeat(40)}`;
    // The 8192-byte tail of the raw output starts 20 characters before the
    // token ends: cut first, those 20 would carry no sigil to scrub by.
    const rest = `\n${"y".repeat(8192 - 21)}`;
    const done = service.runCommands(["./run.sh"], { cwd: "/wt", env: {}, onProgress: vi.fn() });

    run.print(`${"x".repeat(99)} ${token}${rest}`);
    run.exit(0);
    const { output } = await done;

    expect(output).toContain("...(truncated — omitted ");
    expect(output).not.toContain("b".repeat(20));
    expect(output).toContain("[REDACTED]");
  });

  describe("runLifecycleSetup", () => {
    function makeMonitor() {
      let lifecycleStatus: WorktreeLifecycleStatus | undefined;
      return {
        name: "wt-1",
        branch: "feature/x",
        path: "/wt",
        worktreeMode: "local",
        hasResourceConfig: false,
        resourceStatus: undefined,
        get lifecycleStatus() {
          return lifecycleStatus;
        },
        setLifecycleStatus(status: WorktreeLifecycleStatus | undefined) {
          lifecycleStatus = status;
        },
        setHasResourceConfig: vi.fn(),
        setHasStatusCommand: vi.fn(),
        setHasPauseCommand: vi.fn(),
        setHasResumeCommand: vi.fn(),
        setHasTeardownCommand: vi.fn(),
        setHasProvisionCommand: vi.fn(),
        setResourceProvider: vi.fn(),
        setResourceConnectCommand: vi.fn(),
        setResourcePollInterval: vi.fn(),
      };
    }

    beforeEach(() => {
      mockAccess.mockImplementation(async (p: unknown) => {
        if (n(p as string).endsWith("/root/.daintree/config.json")) return undefined;
        throw new Error("ENOENT");
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({ setup: ["node scripts/link.mjs", "npm run build"] }) as never
      );
    });

    it("shows what setup has printed while it runs, which command, and since when", async () => {
      const runs = [controlledChild(), controlledChild()];
      mockSpawn.mockReturnValueOnce(runs[0].child).mockReturnValueOnce(runs[1].child);
      const monitor = makeMonitor();
      const ctx = {
        projectRootPath: "/root",
        projectEnvVars: {},
        getMonitor: () => monitor as never,
        emitUpdate: vi.fn(),
      } as unknown as import("../WorktreeLifecycleService.js").WorkspaceHostContext;

      const done = service.runLifecycleSetup("wt-1", "/wt", ctx, false);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));

      runs[0].print("Refreshing it with npm ci\n");
      await vi.advanceTimersByTimeAsync(500);
      const first = monitor.lifecycleStatus!;
      expect(first).toMatchObject({
        phase: "setup",
        state: "running",
        commandIndex: 0,
        totalCommands: 2,
        currentCommand: "node scripts/link.mjs",
        output: "Refreshing it with npm ci\n",
      });
      expect(ctx.emitUpdate).toHaveBeenLastCalledWith(monitor);

      runs[0].exit(0);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      const second = monitor.lifecycleStatus!;
      expect(second).toMatchObject({
        state: "running",
        commandIndex: 1,
        currentCommand: "npm run build",
        startedAt: first.startedAt,
        output: "Refreshing it with npm ci\n",
      });
      expect(second.commandStartedAt! - first.commandStartedAt!).toBeGreaterThanOrEqual(500);

      runs[1].print("built\n");
      runs[1].exit(0);
      await done;
      expect(monitor.lifecycleStatus).toMatchObject({
        state: "success",
        output: "Refreshing it with npm ci\nbuilt\n",
      });
    });

    it("keeps what an earlier command printed after a status check took the slot between commands", async () => {
      const runs = [controlledChild(), controlledChild()];
      mockSpawn.mockReturnValueOnce(runs[0].child).mockReturnValueOnce(runs[1].child);
      const monitor = makeMonitor();
      const ctx = {
        projectRootPath: "/root",
        projectEnvVars: {},
        getMonitor: () => monitor as never,
        emitUpdate: vi.fn(),
      } as unknown as import("../WorktreeLifecycleService.js").WorkspaceHostContext;

      const done = service.runLifecycleSetup("wt-1", "/wt", ctx, false);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      runs[0].print("linked node_modules\n");
      await vi.advanceTimersByTimeAsync(500);
      monitor.setLifecycleStatus({
        phase: "resource-status",
        state: "success",
        startedAt: 5,
        completedAt: 6,
      });

      runs[0].exit(0);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      expect(monitor.lifecycleStatus).toMatchObject({
        phase: "setup",
        commandIndex: 1,
        output: "linked node_modules\n",
      });

      runs[1].exit(0);
      await done;
    });

    it("never writes its output over another setup run's status", async () => {
      const run = controlledChild();
      mockReadFile.mockResolvedValue(JSON.stringify({ setup: ["node scripts/link.mjs"] }) as never);
      mockSpawn.mockReturnValueOnce(run.child);
      const monitor = makeMonitor();
      const ctx = {
        projectRootPath: "/root",
        projectEnvVars: {},
        getMonitor: () => monitor as never,
        emitUpdate: vi.fn(),
      } as unknown as import("../WorktreeLifecycleService.js").WorkspaceHostContext;

      const done = service.runLifecycleSetup("wt-1", "/wt", ctx, false);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      const ours = monitor.lifecycleStatus!;
      const another: WorktreeLifecycleStatus = { ...ours, startedAt: ours.startedAt + 1 };
      const settled: WorktreeLifecycleStatus = { ...ours, state: "success", completedAt: 2 };

      for (const holder of [another, settled]) {
        monitor.setLifecycleStatus(holder);
        run.print(`printed while ${holder.state}\n`);
        await vi.advanceTimersByTimeAsync(500);
        expect(monitor.lifecycleStatus).toBe(holder);
      }

      run.exit(0);
      await done;
    });

    it("leaves a later setup run's status alone as it moves on, and still reports its own outcome", async () => {
      const runs = [controlledChild(), controlledChild()];
      mockSpawn.mockReturnValueOnce(runs[0].child).mockReturnValueOnce(runs[1].child);
      const monitor = makeMonitor();
      const ctx = {
        projectRootPath: "/root",
        projectEnvVars: {},
        getMonitor: () => monitor as never,
        emitUpdate: vi.fn(),
      } as unknown as import("../WorktreeLifecycleService.js").WorkspaceHostContext;

      const done = service.runLifecycleSetup("wt-1", "/wt", ctx, false);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      // An environment switch starts another setup without stopping this one.
      const later: WorktreeLifecycleStatus = {
        ...monitor.lifecycleStatus!,
        startedAt: monitor.lifecycleStatus!.startedAt + 1,
      };
      monitor.setLifecycleStatus(later);

      runs[0].exit(0);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      expect(monitor.lifecycleStatus).toBe(later);

      // The coordinator reads the outcome back from the slot as this returns.
      runs[1].exit(1);
      await done;
      expect(monitor.lifecycleStatus).toMatchObject({
        phase: "setup",
        state: "failed",
        startedAt: later.startedAt - 1,
      });
    });

    it("leaves the slot to another phase that has taken it", async () => {
      const run = controlledChild();
      mockReadFile.mockResolvedValue(JSON.stringify({ setup: ["node scripts/link.mjs"] }) as never);
      mockSpawn.mockReturnValueOnce(run.child);
      const monitor = makeMonitor();
      const ctx = {
        projectRootPath: "/root",
        projectEnvVars: {},
        getMonitor: () => monitor as never,
        emitUpdate: vi.fn(),
      } as unknown as import("../WorktreeLifecycleService.js").WorkspaceHostContext;

      const done = service.runLifecycleSetup("wt-1", "/wt", ctx, false);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      const other: WorktreeLifecycleStatus = {
        phase: "resource-status",
        state: "running",
        startedAt: 1,
      };
      monitor.setLifecycleStatus(other);

      run.print("still going\n");
      await vi.advanceTimersByTimeAsync(500);
      expect(monitor.lifecycleStatus).toBe(other);

      run.exit(0);
      await done;
    });
  });
});
