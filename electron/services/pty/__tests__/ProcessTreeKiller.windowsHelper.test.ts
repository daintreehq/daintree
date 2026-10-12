import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import type { PluginPtyHostEvent } from "../../../../shared/types/pty-host.js";
import {
  createFakeTreeKillHelper,
  settleIo,
  type FakeTreeKillHelper,
} from "../../../utils/__tests__/helpers/fakeTreeKillHelper.js";

// The real tree kill and its persistent helper; only the processes are fake.
const { spawnMock, spawnSyncMock, execFileMock, ptySpawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  execFileMock: vi.fn(),
  ptySpawnMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
  execFile: execFileMock,
}));
vi.mock("node-pty", () => ({
  spawn: (...args: unknown[]) => ptySpawnMock(...args) as unknown,
}));

const { ProcessTreeKiller, beginWindowsExitBatch, flushWindowsExitBatchAsync } =
  await import("../ProcessTreeKiller.js");
const { PluginPtyProcessManager } =
  await import("../../../pty-host/services/PluginPtyProcessManager.js");
const { disposeWindowsTreeKillService, keepWindowsTreeKillHelperWarm } =
  await import("../../../utils/windowsTreeKill.js");

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function makePty(pid: number): IPty {
  return {
    pid,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  } as unknown as IPty;
}

/** A report in which every root of request `n` was found and killed. */
function killedEverything(helper: FakeTreeKillHelper, n: number): string[] {
  const roots = helper.rootsOf(n);
  return [
    ...roots.map((_pid, i) => `R ${i} tree ${1_000 + i}`),
    "K",
    ...roots.map((pid, i) => `P ${i} ${pid} killed`),
  ];
}

describe("ProcessTreeKiller on the persistent Windows helper", () => {
  let helpers: FakeTreeKillHelper[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    helpers = [];
    spawnMock.mockReset().mockImplementation(() => {
      const helper = createFakeTreeKillHelper(9_000 + helpers.length);
      helpers.push(helper);
      return helper.child;
    });
    spawnSyncMock.mockReset();
    execFileMock.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    disposeWindowsTreeKillService();
    Object.defineProperty(process, "platform", originalPlatform);
    warnSpy.mockRestore();
  });

  it("closes a project's terminals with one PowerShell and one census", async () => {
    const shells = Array.from({ length: 15 }, (_v, i) => 7_100_000 + i);
    const ptys = shells.map(makePty);

    for (const pty of ptys) new ProcessTreeKiller(pty, null).execute(false);
    await settleIo();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(helpers[0].requests).toHaveLength(1);
    expect(helpers[0].rootsOf(0)).toEqual(shells);
    // Each pseudoconsole stays open until its tree is gone: closing it ends the
    // shell the walk starts from.
    for (const pty of ptys) expect(pty.kill).not.toHaveBeenCalled();

    helpers[0].answer(killedEverything(helpers[0], 0));
    await settleIo();

    for (const pty of ptys) expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("runs a kill that arrives mid-run next, on the same helper", async () => {
    const first = makePty(7_200_001);
    const second = makePty(7_200_002);

    new ProcessTreeKiller(first, null).execute(false);
    await settleIo();
    new ProcessTreeKiller(second, null).execute(false);
    await settleIo();
    expect(helpers[0].requests).toHaveLength(1);

    helpers[0].answer(killedEverything(helpers[0], 0));
    await settleIo();
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(helpers[0].rootsOf(1)).toEqual([7_200_002]);
    expect(second.kill).not.toHaveBeenCalled();

    helpers[0].answer(killedEverything(helpers[0], 1));
    await settleIo();
    expect(second.kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("sends the quit batch to the warm helper instead of a cold blocking PowerShell", async () => {
    keepWindowsTreeKillHelperWarm(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const ptys = [makePty(7_300_001), makePty(7_300_002)];

    beginWindowsExitBatch();
    for (const pty of ptys) new ProcessTreeKiller(pty, null).execute(true);
    const flushing = flushWindowsExitBatchAsync();
    await settleIo();

    expect(helpers[0].requests).toHaveLength(1);
    expect(helpers[0].rootsOf(0)).toEqual([7_300_001, 7_300_002]);
    expect(ptys[0].kill).not.toHaveBeenCalled();

    helpers[0].answer(killedEverything(helpers[0], 0));
    await flushing;

    for (const pty of ptys) expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("lets a quit wait on a closing terminal's kill instead of walking its bare PID again", async () => {
    keepWindowsTreeKillHelperWarm(true);
    const pty = makePty(7_350_001);
    const killer = new ProcessTreeKiller(pty, null);

    killer.execute(false);
    await settleIo();
    beginWindowsExitBatch();
    killer.execute(true);
    const flushing = flushWindowsExitBatchAsync();
    await settleIo();

    expect(helpers[0].requests).toHaveLength(1);
    helpers[0].answer(killedEverything(helpers[0], 0));
    await flushing;
    await settleIo();

    // Nothing else was sent: the shell's PID is free once that kill ended it.
    expect(helpers[0].requests).toHaveLength(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it("kills a plugin PTY's tree on the helper and releases ConPTY only afterwards", async () => {
    const calls: string[] = [];
    ptySpawnMock.mockReturnValue({
      pid: 7_400_001,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => calls.push("kill"),
      destroy: () => calls.push("destroy"),
    });
    const events: PluginPtyHostEvent[] = [];
    const manager = new PluginPtyProcessManager(
      (event) => events.push(event),
      (target, origin) => new ProcessTreeKiller(target, null, null, origin)
    );

    manager.spawn("dev-server", 1, {
      command: "npm",
      args: ["run", "dev"],
      cwd: "/repo",
      env: {},
      cols: 80,
      rows: 24,
    });
    manager.kill("dev-server", 1, "SIGTERM");
    await settleIo();

    expect(helpers[0].rootsOf(0)).toEqual([7_400_001]);
    expect(calls).toEqual([]);

    helpers[0].answer(killedEverything(helpers[0], 0));
    await settleIo();
    expect(calls).toContain("destroy");
  });
});
