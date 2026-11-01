import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeShutdown: null as object | null,
  appImage: null as string | null,
  isPackaged: true,
  systemdRunning: true,
  relocationHandlers: [] as Array<(relocation: { previous: string; next: string }) => void>,
  systemdDeps: [] as Array<Record<string, unknown>>,
  launchAgentDeps: [] as Array<Record<string, unknown>>,
  followAppImageMove: vi.fn(),
}));

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  const existsSync = (file: import("node:fs").PathLike) =>
    file === "/run/systemd/system" ? mocks.systemdRunning : actual.existsSync(file);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => "/home/someone/.config/Daintree",
    getAppPath: () => "/src/daintree",
    get isPackaged() {
      return mocks.isPackaged;
    },
  },
}));

vi.mock("../../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => mocks.activeShutdown,
}));

vi.mock("../../../utils/appImage.js", () => ({ runningAppImage: () => mocks.appImage }));

vi.mock("../../appImageRelocation.js", () => ({
  onAppImageRelocated: (handler: (relocation: { previous: string; next: string }) => void) =>
    mocks.relocationHandlers.push(handler),
}));

vi.mock("../../ProjectStore.js", () => ({
  projectStore: {
    getAllProjectIdentities: () => [],
    schedules: {
      list: async (projectId: string) => ({ projectId, schedules: [], revision: 1 }),
      subscribe: () => () => {},
    },
  },
}));

function fakeAdapter(kind: string) {
  return {
    kind,
    unavailable: null,
    sync: vi.fn(async () => {}),
    observe: vi.fn(async () => ({ installed: false, current: true, loaded: false })),
    followAppImageMove: mocks.followAppImageMove,
  };
}

vi.mock("../systemdScheduleJob.js", async (importActual) => ({
  ...(await importActual<object>()),
  createSystemdScheduleJob: (deps: Record<string, unknown>) => {
    mocks.systemdDeps.push(deps);
    return fakeAdapter("systemd-timer");
  },
}));

vi.mock("../launchAgentScheduleJob.js", async (importActual) => ({
  ...(await importActual<object>()),
  createLaunchAgentScheduleJob: (deps: Record<string, unknown>) => {
    mocks.launchAgentDeps.push(deps);
    return fakeAdapter("launch-agent");
  },
}));

const realPlatform = process.platform;
const realArgv = process.argv;

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

async function live() {
  return import("../scheduleOsJobLive.js");
}

beforeEach(() => {
  vi.resetModules();
  mocks.activeShutdown = null;
  mocks.appImage = null;
  mocks.isPackaged = true;
  mocks.systemdRunning = true;
  mocks.relocationHandlers.length = 0;
  mocks.systemdDeps.length = 0;
  mocks.launchAgentDeps.length = 0;
  mocks.followAppImageMove.mockReset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  onPlatform(realPlatform);
  process.argv = realArgv;
  vi.unstubAllEnvs();
});

describe("scheduleOsJobLive", () => {
  it("keeps a systemd timer on Linux, starting the AppImage this process runs from", async () => {
    onPlatform("linux");
    mocks.appImage = "/home/someone/Apps/Daintree.AppImage";
    vi.stubEnv("APPIMAGE_EXTRACT_AND_RUN", "1");
    const { scheduleOsJobStatus } = await live();

    const status = await scheduleOsJobStatus("p1");

    expect(status.context.kind).toBe("systemd-timer");
    expect(mocks.launchAgentDeps).toEqual([]);
    expect(mocks.systemdDeps).toHaveLength(1);
    expect(mocks.systemdDeps[0]).toMatchObject({
      userDataDir: "/home/someone/.config/Daintree",
      target: {
        ok: true,
        target: {
          executable: "/home/someone/Apps/Daintree.AppImage",
          appPath: null,
          userDataDir: "/home/someone/.config/Daintree",
          appImageExtractAndRun: true,
          noSandbox: false,
        },
      },
    });
  });

  it("says why there's no timer where systemd isn't the init system", async () => {
    onPlatform("linux");
    mocks.systemdRunning = false;
    const { scheduleOsJobStatus } = await live();
    await scheduleOsJobStatus("p1");

    expect(mocks.systemdDeps[0]!.target).toEqual({
      ok: false,
      unavailable: expect.stringMatching(/doesn't run systemd/),
    });
  });

  it("passes a dev run's --no-sandbox and app folder on, and never a packaged run's switch", async () => {
    onPlatform("linux");
    mocks.isPackaged = false;
    process.argv = [...realArgv, "--no-sandbox"];
    Object.defineProperty(process, "defaultApp", { value: true, configurable: true });
    try {
      const { scheduleOsJobStatus } = await live();
      await scheduleOsJobStatus("p1");
    } finally {
      Object.defineProperty(process, "defaultApp", { value: undefined, configurable: true });
    }

    expect(mocks.systemdDeps[0]!.target).toMatchObject({
      ok: true,
      target: { executable: process.execPath, appPath: "/src/daintree", noSandbox: true },
    });
  });

  it("follows an AppImage move once, through the job, even after the job has stopped", async () => {
    onPlatform("linux");
    mocks.appImage = "/home/someone/Apps/Daintree-1.0.0.AppImage";
    const { scheduleOsJobStatus, stopScheduleOsJob } = await live();
    await scheduleOsJobStatus("p1");
    await scheduleOsJobStatus("p1");
    await stopScheduleOsJob();

    expect(mocks.relocationHandlers).toHaveLength(1);
    const relocation = {
      previous: "/home/someone/Apps/Daintree-1.0.0.AppImage",
      next: "/home/someone/Apps/Daintree-1.1.0.AppImage",
    };
    mocks.relocationHandlers[0]!(relocation);
    expect(mocks.followAppImageMove).toHaveBeenCalledWith(relocation);
  });

  it("follows no move for a Daintree that isn't an AppImage", async () => {
    onPlatform("linux");
    const { scheduleOsJobStatus } = await live();
    await scheduleOsJobStatus("p1");

    expect(mocks.relocationHandlers).toEqual([]);
  });

  it("keeps the LaunchAgent on macOS", async () => {
    onPlatform("darwin");
    const { scheduleOsJobStatus } = await live();

    expect((await scheduleOsJobStatus("p1")).context.kind).toBe("launch-agent");
    expect(mocks.launchAgentDeps).toHaveLength(1);
    expect(mocks.systemdDeps).toEqual([]);
  });

  it("keeps no job on Windows yet, and none once shutdown has begun", async () => {
    onPlatform("win32");
    const first = await live();
    expect(await first.scheduleOsJobStatus("p1")).toMatchObject({
      context: { kind: null },
      state: "none",
    });
    vi.resetModules();

    onPlatform("linux");
    mocks.activeShutdown = {};
    const second = await live();
    await second.scheduleOsJobStatus("p1");
    expect(mocks.systemdDeps).toEqual([]);
    expect(mocks.launchAgentDeps).toEqual([]);
  });
});
