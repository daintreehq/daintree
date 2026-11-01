import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../../../remote/host/hostCommands.js";
import type { StartAtLoginFs } from "../../../remote/host/startAtLogin.js";
import {
  buildScheduleLaunchAgentPlist,
  createLaunchAgentScheduleJob,
  launchAgentTargetFor,
  scheduleJobCalendar,
  scheduleLaunchAgentArguments,
  scheduleLaunchAgentLabel,
  type LaunchAgentTargetResult,
} from "../launchAgentScheduleJob.js";

const HOME = "/Users/someone";
const USER_DATA = "/Users/someone/Library/Application Support/Daintree";
const LABEL = scheduleLaunchAgentLabel(USER_DATA);
const FILE = `${HOME}/Library/LaunchAgents/${LABEL}.plist`;
const SERVICE = `gui/501/${LABEL}`;

const TARGET: LaunchAgentTargetResult = launchAgentTargetFor({
  execPath: "/Applications/Daintree.app/Contents/MacOS/Daintree",
  appPath: null,
  userDataDir: USER_DATA,
  bundleId: "org.daintree.app",
});

const NINE = { cron: "0 9 * * *", timeZone: "Europe/London" };
const HOURLY = { cron: "30 * * * *", timeZone: "Europe/London" };

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const touched: string[] = [];
  const fs: StartAtLoginFs = {
    readFile: vi.fn(async (file: string) => {
      touched.push(file);
      return files.get(file) ?? null;
    }),
    writeFile: vi.fn(async (file: string, content: string) => {
      touched.push(file);
      files.set(file, content);
    }),
    remove: vi.fn(async (file: string) => {
      touched.push(file);
      files.delete(file);
    }),
  };
  return { fs, files, touched };
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const notFound: CommandResult = {
  code: 113,
  stdout: "",
  stderr: 'Could not find service "x" in domain for user gui: 501',
};

/** A launchd that loads on bootstrap and unloads on bootout, unless told otherwise. */
function fakeLaunchctl(options: {
  loaded?: boolean;
  bootoutSticks?: boolean;
  bootstrapFailures?: number;
}) {
  let loaded = options.loaded ?? false;
  let bootstrapFailures = options.bootstrapFailures ?? 0;
  const calls: string[][] = [];
  const run = vi.fn(async (file: string, args: readonly string[]): Promise<CommandResult> => {
    expect(file).toBe("/bin/launchctl");
    calls.push([...args]);
    switch (args[0]) {
      case "print":
        return loaded ? ok() : notFound;
      case "bootout":
        if (!options.bootoutSticks) loaded = false;
        return options.bootoutSticks ? { code: 5, stdout: "", stderr: "Boot-out failed: 5" } : ok();
      case "bootstrap":
        if (bootstrapFailures > 0) {
          bootstrapFailures -= 1;
          return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
        }
        loaded = true;
        return ok();
      default:
        throw new Error(`unexpected launchctl ${args.join(" ")}`);
    }
  });
  return { run, calls, isLoaded: () => loaded };
}

function job(
  launchctl: ReturnType<typeof fakeLaunchctl>,
  files: ReturnType<typeof memoryFs>,
  target = TARGET
) {
  return createLaunchAgentScheduleJob({
    homeDir: HOME,
    uid: 501,
    userDataDir: USER_DATA,
    target,
    run: launchctl.run,
    fs: files.fs,
    delay: async () => {},
  });
}

const commands = (launchctl: ReturnType<typeof fakeLaunchctl>) =>
  launchctl.calls.map((args) => args[0]);

describe("launchAgentTargetFor", () => {
  it("launches the app bundle the executable is inside", () => {
    expect(TARGET).toEqual({
      ok: true,
      target: {
        bundlePath: "/Applications/Daintree.app",
        appPath: null,
        userDataDir: USER_DATA,
        bundleId: "org.daintree.app",
      },
    });
  });

  it("refuses an executable outside an app bundle", () => {
    const result = launchAgentTargetFor({
      execPath: "/usr/local/bin/electron",
      appPath: "/src/daintree",
      userDataDir: USER_DATA,
      bundleId: "com.github.Electron",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a translocated copy, which is gone once it quits", () => {
    const result = launchAgentTargetFor({
      execPath:
        "/private/var/folders/x/AppTranslocation/ABC/d/Daintree.app/Contents/MacOS/Daintree",
      appPath: null,
      userDataDir: USER_DATA,
      bundleId: "org.daintree.app",
    });
    expect(result).toMatchObject({ ok: false, unavailable: expect.stringMatching(/Applications/) });
  });
});

describe("scheduleLaunchAgentLabel", () => {
  it("gives each profile its own label and keeps it stable", () => {
    expect(scheduleLaunchAgentLabel(USER_DATA)).toBe(LABEL);
    expect(scheduleLaunchAgentLabel("/tmp/other-profile")).not.toBe(LABEL);
    expect(LABEL.startsWith("org.daintree.app.schedules.")).toBe(true);
  });
});

describe("scheduleLaunchAgentArguments", () => {
  it("opens the app as a new background process with only the due-schedules switch and its profile", () => {
    if (!TARGET.ok) throw new Error("target");
    expect(scheduleLaunchAgentArguments(TARGET.target)).toEqual([
      "/usr/bin/open",
      "-n",
      "-g",
      "-a",
      "/Applications/Daintree.app",
      "--args",
      `--user-data-dir=${USER_DATA}`,
      "--run-due-schedules",
    ]);
  });

  it("passes a dev build's app folder to Electron.app first", () => {
    const dev = launchAgentTargetFor({
      execPath: "/src/daintree/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      appPath: "/src/daintree",
      userDataDir: "/tmp/daintree-dev",
      bundleId: "com.github.Electron",
    });
    if (!dev.ok) throw new Error(dev.unavailable);
    const args = scheduleLaunchAgentArguments(dev.target);
    expect(args.slice(4)).toEqual([
      "/src/daintree/node_modules/electron/dist/Electron.app",
      "--args",
      "/src/daintree",
      "--user-data-dir=/tmp/daintree-dev",
      "--run-due-schedules",
    ]);
  });
});

describe("buildScheduleLaunchAgentPlist", () => {
  it("escapes every value and never starts at load", () => {
    const plist = buildScheduleLaunchAgentPlist({
      label: LABEL,
      programArguments: ["/usr/bin/open", "-a", "/Apps/R&D <x>.app"],
      calendar: [{ Weekday: 1, Hour: 9, Minute: 0 }],
      bundleId: "org.daintree.app",
    });
    expect(plist).toContain("<string>/Apps/R&amp;D &lt;x&gt;.app</string>");
    expect(plist).not.toContain("RunAtLoad");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(
      [
        "\t\t<dict>",
        "\t\t\t<key>Weekday</key>",
        "\t\t\t<integer>1</integer>",
        "\t\t\t<key>Hour</key>",
        "\t\t\t<integer>9</integer>",
        "\t\t\t<key>Minute</key>",
        "\t\t\t<integer>0</integer>",
        "\t\t</dict>",
      ].join("\n")
    );
  });
});

describe("scheduleJobCalendar", () => {
  it("writes an entry two schedules share once, in a stable order", () => {
    const calendar = scheduleJobCalendar(
      [NINE, HOURLY, { cron: "0 9 * * *", timeZone: "Europe/London" }],
      "Europe/London"
    );
    expect(calendar).toEqual([{ Minute: 30 }, { Hour: 9, Minute: 0 }]);
    expect(scheduleJobCalendar([HOURLY, NINE], "Europe/London")).toEqual(calendar);
  });

  it("leaves out a cadence launchd can't hold", () => {
    expect(
      scheduleJobCalendar([{ cron: "0 9 * * *", timeZone: "Asia/Tokyo" }, HOURLY], "Europe/London")
    ).toEqual([{ Minute: 30 }]);
  });
});

describe("createLaunchAgentScheduleJob", () => {
  it("installs and loads a job for the first opted-in schedule", async () => {
    const launchctl = fakeLaunchctl({});
    const files = memoryFs();
    await job(launchctl, files).sync([NINE], "Europe/London", { reload: false });

    expect(files.files.get(FILE)).toContain("<key>StartCalendarInterval</key>");
    expect(launchctl.calls).toEqual([
      ["print", SERVICE],
      ["bootstrap", "gui/501", FILE],
      ["print", SERVICE],
    ]);
    expect(launchctl.isLoaded()).toBe(true);
  });

  it("leaves a loaded job that already reads current alone", async () => {
    const launchctl = fakeLaunchctl({});
    const files = memoryFs();
    const adapter = job(launchctl, files);
    await adapter.sync([NINE], "Europe/London", { reload: false });
    launchctl.calls.length = 0;
    vi.mocked(files.fs.writeFile).mockClear();

    await adapter.sync([NINE], "Europe/London", { reload: false });

    expect(files.fs.writeFile).not.toHaveBeenCalled();
    expect(commands(launchctl)).toEqual(["print"]);
  });

  it("unloads the old job before writing a new calendar, then loads it", async () => {
    const launchctl = fakeLaunchctl({});
    const files = memoryFs();
    const adapter = job(launchctl, files);
    await adapter.sync([NINE], "Europe/London", { reload: false });
    launchctl.calls.length = 0;

    await adapter.sync([NINE, HOURLY], "Europe/London", { reload: false });

    expect(commands(launchctl)).toEqual(["print", "bootout", "print", "bootstrap", "print"]);
    expect(files.files.get(FILE)).toContain("<integer>30</integer>");
  });

  it("reloads a current job when asked to", async () => {
    const launchctl = fakeLaunchctl({});
    const files = memoryFs();
    const adapter = job(launchctl, files);
    await adapter.sync([NINE], "Europe/London", { reload: false });
    launchctl.calls.length = 0;

    await adapter.sync([NINE], "Europe/London", { reload: true });

    expect(commands(launchctl)).toEqual(["print", "bootout", "print", "bootstrap", "print"]);
  });

  it("keeps the old file when the old job won't unload, so it never reads current", async () => {
    const launchctl = fakeLaunchctl({ loaded: true, bootoutSticks: true });
    const files = memoryFs({ [FILE]: "old" });

    await expect(
      job(launchctl, files).sync([NINE], "Europe/London", { reload: false })
    ).rejects.toThrow(/Couldn't unload the old macOS job \(launchctl exited 5\)/);

    expect(files.files.get(FILE)).toBe("old");
    expect(commands(launchctl)).not.toContain("bootstrap");
  });

  it("tries loading again before giving up, naming launchctl's answer", async () => {
    const retried = fakeLaunchctl({ bootstrapFailures: 2 });
    await job(retried, memoryFs()).sync([NINE], "Europe/London", { reload: false });
    expect(commands(retried).filter((command) => command === "bootstrap")).toHaveLength(3);
    expect(retried.isLoaded()).toBe(true);

    const failing = fakeLaunchctl({ bootstrapFailures: 3 });
    await expect(
      job(failing, memoryFs()).sync([NINE], "Europe/London", { reload: false })
    ).rejects.toThrow(
      "Couldn't load the macOS job (launchctl exited 5): Bootstrap failed: 5: Input/output error"
    );
  });

  it("removes the job when no schedule needs it", async () => {
    const launchctl = fakeLaunchctl({});
    const files = memoryFs();
    const adapter = job(launchctl, files);
    await adapter.sync([NINE], "Europe/London", { reload: false });
    launchctl.calls.length = 0;

    await adapter.sync([], "Europe/London", { reload: false });

    expect(files.files.has(FILE)).toBe(false);
    expect(commands(launchctl)).toEqual(["print", "bootout", "print"]);

    launchctl.calls.length = 0;
    await adapter.sync([], "Europe/London", { reload: false });
    expect(commands(launchctl)).toEqual(["print"]);
  });

  it("removes the file even when the job won't unload, and says so", async () => {
    const launchctl = fakeLaunchctl({ loaded: true, bootoutSticks: true });
    const files = memoryFs({ [FILE]: "old" });

    await expect(job(launchctl, files).sync([], "Europe/London", { reload: false })).rejects.toThrow(
      /Couldn't unload/
    );
    expect(files.files.has(FILE)).toBe(false);
  });

  it("writes nothing from a copy that can't point a job at itself", async () => {
    const launchctl = fakeLaunchctl({ loaded: true });
    const files = memoryFs({ [FILE]: "installed elsewhere" });
    const unavailable: LaunchAgentTargetResult = { ok: false, unavailable: "temporary copy" };
    const adapter = job(launchctl, files, unavailable);

    expect(adapter.unavailable).toBe("temporary copy");
    await expect(adapter.sync([NINE], "Europe/London", { reload: true })).rejects.toThrow(
      "temporary copy"
    );
    expect(files.files.get(FILE)).toBe("installed elsewhere");
    expect(launchctl.calls).toEqual([]);
  });

  it("touches only its own file and its own service", async () => {
    const launchctl = fakeLaunchctl({});
    const files = memoryFs();
    const adapter = job(launchctl, files);
    await adapter.sync([NINE], "Europe/London", { reload: false });
    await adapter.sync([NINE, HOURLY], "Europe/London", { reload: true });
    await adapter.observe([NINE], "Europe/London");
    await adapter.sync([], "Europe/London", { reload: false });

    expect(new Set(files.touched)).toEqual(new Set([FILE]));
    for (const args of launchctl.calls) {
      expect(args.slice(1)).toEqual(args[0] === "bootstrap" ? ["gui/501", FILE] : [SERVICE]);
    }
  });

  it("observes whether the job is installed, current and loaded", async () => {
    const launchctl = fakeLaunchctl({});
    const files = memoryFs();
    const adapter = job(launchctl, files);

    expect(await adapter.observe([NINE], "Europe/London")).toEqual({
      installed: false,
      current: false,
      loaded: false,
    });
    await adapter.sync([NINE], "Europe/London", { reload: false });
    expect(await adapter.observe([NINE], "Europe/London")).toEqual({
      installed: true,
      current: true,
      loaded: true,
    });
    expect(await adapter.observe([NINE, HOURLY], "Europe/London")).toMatchObject({
      current: false,
    });
    expect(await adapter.observe([], "Europe/London")).toMatchObject({ current: false });
  });

  it("reads a launchctl that couldn't answer as unknown, not unloaded", async () => {
    const files = memoryFs();
    const run = vi.fn(
      async (): Promise<CommandResult> => ({
        code: null,
        stdout: "",
        stderr: "",
        failure: "timeout",
      })
    );
    const adapter = createLaunchAgentScheduleJob({
      homeDir: HOME,
      uid: 501,
      userDataDir: USER_DATA,
      target: TARGET,
      run,
      fs: files.fs,
      delay: async () => {},
    });
    expect((await adapter.observe([NINE], "Europe/London")).loaded).toBeNull();
  });
});
