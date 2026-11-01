import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../../../utils/runCommand.js";
import {
  buildScheduleLaunchAgentPlist,
  createLaunchAgentScheduleJob,
  launchAgentTargetFor,
  scheduleJobCalendar,
  scheduleLaunchAgentArguments,
  scheduleLaunchAgentLabel,
  type LaunchAgentTargetResult,
  nodeScheduleJobFs,
  type ScheduleJobFs,
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

function memoryFs(initial: Record<string, string> = {}, events: string[] = []) {
  const files = new Map(Object.entries(initial));
  const touched: string[] = [];
  const fs: ScheduleJobFs = {
    readFile: vi.fn(async (file: string) => {
      touched.push(file);
      return files.get(file) ?? null;
    }),
    writeFile: vi.fn(async (file: string, content: string) => {
      touched.push(file);
      events.push("write");
      files.set(file, content);
    }),
    remove: vi.fn(async (file: string) => {
      touched.push(file);
      events.push("remove");
      files.delete(file);
    }),
  };
  return { fs, files, touched, events };
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const notFound: CommandResult = {
  code: 113,
  stdout: "",
  stderr: 'Could not find service "x" in domain for user gui: 501',
};

const unanswered: CommandResult = { code: null, stdout: "", stderr: "", failure: "timeout" };

/**
 * A launchd that loads on bootstrap and unloads on bootout, unless told
 * otherwise. Bootstrap loads only a file that names the job's label and runs
 * `open`, as launchd refuses a plist it can't read.
 */
function fakeLaunchctl(options: {
  loaded?: boolean;
  bootoutSticks?: boolean;
  /** Status reads that still list the job after a bootout that answered 0. */
  listedAfterBootout?: number;
  /** Status reads after the bootout that launchctl doesn't answer. */
  unansweredAfterBootout?: boolean;
  bootstrapFailures?: number;
  /** Bootstrap answers 0 and loads nothing. */
  bootstrapLoadsNothing?: boolean;
  files?: Map<string, string>;
  events?: string[];
}) {
  let loaded = options.loaded ?? false;
  let bootstrapFailures = options.bootstrapFailures ?? 0;
  let stillListed = 0;
  let bootedOut = false;
  const calls: string[][] = [];
  const run = vi.fn(
    async (
      file: string,
      args: readonly string[],
      _options?: { timeoutMs?: number }
    ): Promise<CommandResult> => {
      expect(file).toBe("/bin/launchctl");
      calls.push([...args]);
      options.events?.push(args[0]!);
      switch (args[0]) {
        case "print":
          if (bootedOut && options.unansweredAfterBootout) return unanswered;
          if (stillListed > 0) {
            stillListed -= 1;
            return ok();
          }
          return loaded ? ok() : notFound;
        case "bootout":
          bootedOut = true;
          if (options.bootoutSticks) return { code: 5, stdout: "", stderr: "Boot-out failed: 5" };
          loaded = false;
          stillListed = options.listedAfterBootout ?? 0;
          return ok();
        case "bootstrap": {
          if (bootstrapFailures > 0) {
            bootstrapFailures -= 1;
            return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
          }
          const content = options.files?.get(args[2]!);
          if (
            options.files &&
            !(
              content?.includes(`\t<key>Label</key>\n\t<string>${LABEL}</string>`) &&
              content.includes(
                `\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/usr/bin/open</string>`
              )
            )
          ) {
            return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: unreadable plist" };
          }
          if (!options.bootstrapLoadsNothing) loaded = true;
          return ok();
        }
        default:
          throw new Error(`unexpected launchctl ${args.join(" ")}`);
      }
    }
  );
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
  it("names the job by twelve hex digits of its profile's path", () => {
    const digest = createHash("sha256").update(USER_DATA).digest("hex");
    expect(LABEL).toBe(`org.daintree.app.schedules.${digest.slice(0, 12)}`);
    expect(scheduleLaunchAgentLabel("/tmp/other-profile")).not.toBe(LABEL);
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
  it("writes the whole job: label, program, calendar, session and owner", () => {
    expect(
      buildScheduleLaunchAgentPlist({
        label: "org.example.job",
        programArguments: ["/usr/bin/open", "-a", "/Applications/Example.app"],
        calendar: [{ Minute: 30 }, { Month: 2, Day: 29, Hour: 9, Minute: 0 }],
        bundleId: "org.example.app",
      })
    ).toBe(
      [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
        `<plist version="1.0">`,
        `<dict>`,
        `\t<key>Label</key>`,
        `\t<string>org.example.job</string>`,
        `\t<key>ProgramArguments</key>`,
        `\t<array>`,
        `\t\t<string>/usr/bin/open</string>`,
        `\t\t<string>-a</string>`,
        `\t\t<string>/Applications/Example.app</string>`,
        `\t</array>`,
        `\t<key>StartCalendarInterval</key>`,
        `\t<array>`,
        `\t\t<dict>`,
        `\t\t\t<key>Minute</key>`,
        `\t\t\t<integer>30</integer>`,
        `\t\t</dict>`,
        `\t\t<dict>`,
        `\t\t\t<key>Month</key>`,
        `\t\t\t<integer>2</integer>`,
        `\t\t\t<key>Day</key>`,
        `\t\t\t<integer>29</integer>`,
        `\t\t\t<key>Hour</key>`,
        `\t\t\t<integer>9</integer>`,
        `\t\t\t<key>Minute</key>`,
        `\t\t\t<integer>0</integer>`,
        `\t\t</dict>`,
        `\t</array>`,
        `\t<key>LimitLoadToSessionType</key>`,
        `\t<string>Aqua</string>`,
        `\t<key>AssociatedBundleIdentifiers</key>`,
        `\t<array>`,
        `\t\t<string>org.example.app</string>`,
        `\t</array>`,
        `</dict>`,
        `</plist>`,
        ``,
      ].join("\n")
    );
  });

  it("escapes every value and never starts at load", () => {
    const plist = buildScheduleLaunchAgentPlist({
      label: 'a&b<"c">',
      programArguments: ["/usr/bin/open", "-a", "/Apps/R&D <x>.app"],
      calendar: [{ Weekday: 1, Hour: 9, Minute: 0 }],
      bundleId: 'org.r&d<"x">',
    });
    expect(plist).toContain("<string>/Apps/R&amp;D &lt;x&gt;.app</string>");
    expect(plist).toContain("<string>a&amp;b&lt;&quot;c&quot;&gt;</string>");
    expect(plist).toContain("<string>org.r&amp;d&lt;&quot;x&quot;&gt;</string>");
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

/** A launchd and a file system that write to one log, so the order between them shows. */
function machine(
  options: Omit<Parameters<typeof fakeLaunchctl>[0], "files" | "events"> = {},
  initial: Record<string, string> = {}
) {
  const events: string[] = [];
  const files = memoryFs(initial, events);
  const launchctl = fakeLaunchctl({ ...options, files: files.files, events });
  return { files, launchctl, events, adapter: job(launchctl, files) };
}

describe("createLaunchAgentScheduleJob", () => {
  it("installs and loads a job for the first opted-in schedule", async () => {
    const { files, launchctl, adapter } = machine();
    await adapter.sync([NINE], "Europe/London", { reload: false });

    expect(files.files.get(FILE)).toContain("<key>StartCalendarInterval</key>");
    expect(launchctl.calls).toEqual([
      ["print", SERVICE],
      ["bootstrap", "gui/501", FILE],
      ["print", SERVICE],
    ]);
    expect(launchctl.isLoaded()).toBe(true);
  });

  it("leaves a loaded job that already reads current alone", async () => {
    const { files, launchctl, adapter } = machine();
    await adapter.sync([NINE], "Europe/London", { reload: false });
    launchctl.calls.length = 0;
    vi.mocked(files.fs.writeFile).mockClear();

    await adapter.sync([NINE], "Europe/London", { reload: false });

    expect(files.fs.writeFile).not.toHaveBeenCalled();
    expect(commands(launchctl)).toEqual(["print"]);
  });

  it("rewrites the file only once launchd no longer lists the old job, then loads it", async () => {
    const { files, adapter, events } = machine({ listedAfterBootout: 3 });
    await adapter.sync([NINE], "Europe/London", { reload: false });
    events.length = 0;

    await adapter.sync([NINE, HOURLY], "Europe/London", { reload: false });

    expect(events).toEqual([
      "print",
      "bootout",
      "print",
      "print",
      "print",
      "print",
      "write",
      "bootstrap",
      "print",
    ]);
    expect(files.files.get(FILE)).toContain("<integer>30</integer>");
  });

  it("reloads a current job when asked to", async () => {
    const { launchctl, adapter } = machine();
    await adapter.sync([NINE], "Europe/London", { reload: false });
    launchctl.calls.length = 0;

    await adapter.sync([NINE], "Europe/London", { reload: true });

    expect(commands(launchctl)).toEqual(["print", "bootout", "print", "bootstrap", "print"]);
  });

  it("keeps the old file when the old job won't unload, so it never reads current", async () => {
    const { files, launchctl, adapter } = machine(
      { loaded: true, bootoutSticks: true },
      { [FILE]: "old" }
    );

    await expect(adapter.sync([NINE], "Europe/London", { reload: false })).rejects.toThrow(
      /Couldn't unload the old macOS job \(launchctl exited 5\)/
    );

    expect(files.files.get(FILE)).toBe("old");
    expect(commands(launchctl)).not.toContain("bootstrap");
  });

  it("stops waiting for an unload once launchctl stops answering", async () => {
    const { files, launchctl, adapter } = machine(
      { loaded: true, unansweredAfterBootout: true },
      { [FILE]: "old" }
    );

    await expect(adapter.sync([NINE], "Europe/London", { reload: false })).rejects.toThrow(
      /Couldn't unload/
    );
    expect(commands(launchctl)).toEqual(["print", "bootout", "print"]);
    expect(files.files.get(FILE)).toBe("old");
    // A status read that hangs is cut short rather than waited out.
    for (const [, args, options] of launchctl.run.mock.calls) {
      if (args[0] !== "print") continue;
      expect(options?.timeoutMs).toBeGreaterThan(0);
      expect(options?.timeoutMs).toBeLessThanOrEqual(2_000);
    }
  });

  it("tries loading again before giving up, naming launchctl's answer", async () => {
    const retried = machine({ bootstrapFailures: 2 });
    await retried.adapter.sync([NINE], "Europe/London", { reload: false });
    expect(commands(retried.launchctl).filter((command) => command === "bootstrap")).toHaveLength(
      3
    );
    expect(retried.launchctl.isLoaded()).toBe(true);

    const failing = machine({ bootstrapFailures: 3 });
    await expect(failing.adapter.sync([NINE], "Europe/London", { reload: false })).rejects.toThrow(
      "Couldn't load the macOS job (launchctl exited 5): Bootstrap failed: 5: Input/output error"
    );
  });

  it("fails a load launchctl answered but launchd doesn't list", async () => {
    const { adapter } = machine({ bootstrapLoadsNothing: true });
    await expect(adapter.sync([NINE], "Europe/London", { reload: false })).rejects.toThrow(
      /Couldn't load the macOS job/
    );
  });

  it("removes the job's file first when no schedule needs it, then unloads it", async () => {
    const { files, launchctl, adapter, events } = machine();
    await adapter.sync([NINE], "Europe/London", { reload: false });
    events.length = 0;

    await adapter.sync([], "Europe/London", { reload: false });

    expect(files.files.has(FILE)).toBe(false);
    expect(events).toEqual(["print", "remove", "bootout", "print"]);

    launchctl.calls.length = 0;
    await adapter.sync([], "Europe/London", { reload: false });
    expect(commands(launchctl)).toEqual(["print"]);
  });

  it("still unloads the job when its file won't go, and says so", async () => {
    const { files, launchctl, adapter } = machine({}, {});
    await adapter.sync([NINE], "Europe/London", { reload: false });
    vi.mocked(files.fs.remove).mockRejectedValueOnce(new Error("EACCES"));

    await expect(adapter.sync([], "Europe/London", { reload: false })).rejects.toThrow("EACCES");
    expect(launchctl.isLoaded()).toBe(false);
  });

  it("removes and unloads a job whose file can't be read", async () => {
    const { files, launchctl, adapter } = machine();
    await adapter.sync([NINE], "Europe/London", { reload: false });
    vi.mocked(files.fs.readFile).mockRejectedValueOnce(new Error("EACCES"));

    await adapter.sync([], "Europe/London", { reload: false });

    expect(files.files.has(FILE)).toBe(false);
    expect(launchctl.isLoaded()).toBe(false);
  });

  it("removes the file even when the job won't unload, and says so", async () => {
    const { files, adapter } = machine({ loaded: true, bootoutSticks: true }, { [FILE]: "old" });

    await expect(adapter.sync([], "Europe/London", { reload: false })).rejects.toThrow(
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
    const { files, launchctl, adapter } = machine();
    await adapter.sync([NINE], "Europe/London", { reload: false });
    await adapter.sync([NINE, HOURLY], "Europe/London", { reload: true });
    await adapter.observe([NINE], "Europe/London");
    await adapter.sync([], "Europe/London", { reload: false });

    expect(new Set(files.touched)).toEqual(new Set([FILE]));
    for (const args of launchctl.calls) {
      expect(args.slice(1)).toEqual(args[0] === "bootstrap" ? ["gui/501", FILE] : [SERVICE]);
    }
  });

  it("observes whether the job is installed, current and loaded, each on its own", async () => {
    const { adapter } = machine();

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

    const written = machine();
    await written.adapter.sync([NINE], "Europe/London", { reload: false });
    const content = written.files.files.get(FILE)!;
    const unloaded = machine({ loaded: false }, { [FILE]: content });
    expect(await unloaded.adapter.observe([NINE], "Europe/London")).toEqual({
      installed: true,
      current: true,
      loaded: false,
    });
    const fileless = machine({ loaded: true });
    expect(await fileless.adapter.observe([NINE], "Europe/London")).toEqual({
      installed: false,
      current: false,
      loaded: true,
    });
  });

  it("reads a launchctl that couldn't answer as unknown, not unloaded", async () => {
    const files = memoryFs();
    const run = vi.fn(async (): Promise<CommandResult> => unanswered);
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

describe("nodeScheduleJobFs", () => {
  it("makes the folder, writes a file only its owner can change, and reads a missing one as none", async () => {
    const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "daintree-launch-agents-"));
    try {
      const file = nodePath.join(root, "Library", "LaunchAgents", "job.plist");
      expect(await nodeScheduleJobFs.readFile(file)).toBeNull();

      await nodeScheduleJobFs.writeFile(file, "one");
      await nodeScheduleJobFs.writeFile(file, "two");
      expect(await nodeScheduleJobFs.readFile(file)).toBe("two");
      if (process.platform !== "win32") {
        expect(nodeFs.statSync(file).mode & 0o022).toBe(0);
      }
      expect(nodeFs.readdirSync(nodePath.dirname(file))).toEqual(["job.plist"]);

      await nodeScheduleJobFs.remove(file);
      await nodeScheduleJobFs.remove(file);
      expect(await nodeScheduleJobFs.readFile(file)).toBeNull();
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });
});
