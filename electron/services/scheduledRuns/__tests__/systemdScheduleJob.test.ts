import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../../../utils/runCommand.js";
import type { ScheduleJobFs } from "../launchAgentScheduleJob.js";
import {
  DISPLAY_WAIT_SCRIPT,
  buildScheduleAppUnit,
  buildScheduleLauncherUnit,
  buildScheduleTimerUnit,
  createSystemdScheduleJob,
  parseUnitStates,
  scheduleSystemdUnitBase,
  scheduleSystemdUnits,
  scheduleTimerSpecs,
  systemdScheduleTargetFor,
  type SystemdScheduleTarget,
  type SystemdScheduleTargetResult,
} from "../systemdScheduleJob.js";

const HOME = "/home/someone";
const USER_DATA = "/home/someone/.config/Daintree";
const BASE = scheduleSystemdUnitBase(USER_DATA);
const UNITS = scheduleSystemdUnits(USER_DATA);
const TIMER = UNITS.timer;
const LAUNCHER = UNITS.launcher;
const APP = UNITS.app;
const UNIT_DIR = `${HOME}/.config/systemd/user`;
const TIMER_FILE = `${UNIT_DIR}/${TIMER}`;
const LAUNCHER_FILE = `${UNIT_DIR}/${LAUNCHER}`;
const APP_FILE = `${UNIT_DIR}/${APP}`;
const WANTS_LINK = `${UNIT_DIR}/timers.target.wants/${TIMER}`;
const ZONE_KNOWN = () => true;

const DEB: SystemdScheduleTarget = {
  executable: "/opt/Daintree/daintree",
  appPath: null,
  userDataDir: USER_DATA,
  appImageExtractAndRun: false,
  noSandbox: false,
};
const TARGET: SystemdScheduleTargetResult = { ok: true, target: DEB };

const NINE = { cron: "0 9 * * *", timeZone: "Europe/London" };
const HOURLY = { cron: "30 * * * *", timeZone: "Europe/London" };

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });

function memoryFs(initial: Record<string, string> = {}, events: string[] = []) {
  const files = new Map(Object.entries(initial));
  const fs: ScheduleJobFs = {
    readFile: vi.fn(async (file: string) => files.get(file) ?? null),
    writeFile: vi.fn(async (file: string, content: string) => {
      events.push(`write ${nodePath.posix.basename(file)}`);
      files.set(file, content);
    }),
    remove: vi.fn(async (file: string) => {
      if (files.has(file)) events.push(`remove ${nodePath.posix.basename(file)}`);
      files.delete(file);
    }),
  };
  return { fs, files, events };
}

/**
 * A systemd user manager over the job's files: a reload takes what's on disk,
 * enable links the timer into timers.target, and a unit whose file changed
 * since the last reload needs one.
 */
function fakeSystemd(
  files: Map<string, string>,
  options: {
    events?: string[];
    loaded?: Record<string, string>;
    active?: boolean;
    /** The launcher is still waiting for a desktop session. */
    launcherWaiting?: boolean;
    fail?: Partial<Record<string, CommandResult>>;
    unreachable?: boolean;
    unitDir?: string;
  } = {}
) {
  const loaded = new Map(Object.entries(options.loaded ?? {}));
  let active = options.active ?? false;
  let launcherWaiting = options.launcherWaiting ?? false;
  const calls: string[][] = [];
  const unitDir = options.unitDir ?? UNIT_DIR;
  const unitFile = (unit: string) => `${unitDir}/${unit}`;
  const wantsLink = `${unitDir}/timers.target.wants/${TIMER}`;
  const activeState = (unit: string) => {
    if (unit === TIMER) return active ? "active" : "inactive";
    if (unit === LAUNCHER) return launcherWaiting ? "activating" : "inactive";
    return "active";
  };
  const state = (unit: string) => {
    const content = loaded.get(unit);
    const onDisk = files.get(unitFile(unit));
    return [
      `Id=${unit}`,
      `LoadState=${content !== undefined ? "loaded" : "not-found"}`,
      `ActiveState=${activeState(unit)}`,
      `UnitFileState=${unit !== TIMER ? "static" : files.has(wantsLink) ? "enabled" : onDisk !== undefined ? "disabled" : ""}`,
      `NeedDaemonReload=${content !== undefined && onDisk !== content ? "yes" : "no"}`,
    ].join("\n");
  };
  const run = vi.fn(
    async (file: string, args: readonly string[], _options?: { timeoutMs?: number }) => {
      expect(file).toBe("systemctl");
      expect(args[0]).toBe("--user");
      const rest = args.slice(1);
      calls.push(rest);
      if (rest[0] !== "show") options.events?.push(rest.join(" "));
      if (options.unreachable) return failed("Failed to connect to bus: No medium found");
      const failure = options.fail?.[rest[0]!];
      if (failure) return failure;
      switch (rest[0]) {
        case "show": {
          const units = rest.slice(1).filter((arg, i, all) => arg !== "-p" && all[i - 1] !== "-p");
          return ok(`${units.map(state).join("\n\n")}\n`);
        }
        case "daemon-reload":
          loaded.clear();
          for (const unit of [TIMER, LAUNCHER, APP]) {
            const content = files.get(unitFile(unit));
            if (content !== undefined) loaded.set(unit, content);
          }
          if (!loaded.has(TIMER)) active = false;
          return ok();
        case "enable":
          if (!loaded.has(TIMER)) return failed(`Unit file ${TIMER} does not exist.`);
          files.set(wantsLink, "->");
          return ok();
        case "disable":
          files.delete(wantsLink);
          if (rest.includes("--now")) active = false;
          return ok();
        case "clean":
          return ok();
        case "stop":
          if (rest[1] === APP) throw new Error("Daintree's own unit was stopped");
          if (rest[1] === LAUNCHER) launcherWaiting = false;
          return ok();
        case "start":
        case "restart":
          if (rest[1] !== TIMER) throw new Error(`${rest[1]} was ${rest[0]}ed`);
          if (!loaded.has(TIMER)) return failed(`Unit ${TIMER} not found.`);
          active = true;
          return ok();
        default:
          throw new Error(`unexpected systemctl ${rest.join(" ")}`);
      }
    }
  );
  return { run, calls, isActive: () => active, isLauncherWaiting: () => launcherWaiting, loaded };
}

function job(options: {
  files?: ReturnType<typeof memoryFs>;
  systemd: ReturnType<typeof fakeSystemd>;
  target?: SystemdScheduleTargetResult;
  homeDir?: string;
  reloadSync?: () => void;
}) {
  return createSystemdScheduleJob({
    homeDir: options.homeDir ?? HOME,
    userDataDir: USER_DATA,
    target: options.target ?? TARGET,
    run: options.systemd.run,
    reloadSync: options.reloadSync ?? (() => {}),
    zoneKnown: ZONE_KNOWN,
    ...(options.files ? { fs: options.files.fs } : {}),
  });
}

/** A job already installed for these cadences, loaded and waiting. */
function installed(cadences = [NINE]) {
  const timer = buildScheduleTimerUnit({
    units: UNITS,
    specs: scheduleTimerSpecs(cadences, "Europe/London", ZONE_KNOWN),
  });
  const launcher = buildScheduleLauncherUnit(UNITS);
  const app = buildScheduleAppUnit(DEB);
  return {
    [TIMER_FILE]: timer,
    [LAUNCHER_FILE]: launcher,
    [APP_FILE]: app,
    [WANTS_LINK]: "->",
    loaded: { [TIMER]: timer, [LAUNCHER]: launcher, [APP]: app },
  };
}

describe("systemdScheduleTargetFor", () => {
  const input = {
    execPath: "/opt/Daintree/daintree",
    appImage: null,
    appPath: null,
    userDataDir: USER_DATA,
    appImageExtractAndRun: false,
    devNoSandbox: false,
    systemdRunning: true,
  };

  it("runs the AppImage rather than the binary inside its mount", () => {
    expect(
      systemdScheduleTargetFor({
        ...input,
        execPath: "/tmp/.mount_DaintrABC/daintree",
        appImage: "/home/someone/Apps/Daintree.AppImage",
      })
    ).toEqual({
      ok: true,
      target: { ...DEB, executable: "/home/someone/Apps/Daintree.AppImage" },
    });
  });

  it("asks for extract-and-run only of an AppImage", () => {
    const result = (appImage: string | null) =>
      systemdScheduleTargetFor({ ...input, appImage, appImageExtractAndRun: true });
    expect(result("/home/someone/Daintree.AppImage")).toMatchObject({
      target: { appImageExtractAndRun: true },
    });
    expect(result(null)).toMatchObject({ target: { appImageExtractAndRun: false } });
  });

  it("keeps a dev run's --no-sandbox, and never a packaged build's", () => {
    expect(
      systemdScheduleTargetFor({ ...input, appPath: "/src/daintree", devNoSandbox: true })
    ).toMatchObject({ target: { noSandbox: true } });
    expect(systemdScheduleTargetFor({ ...input, devNoSandbox: true })).toMatchObject({
      target: { noSandbox: false },
    });
  });

  it("can't install a timer where systemd isn't running", () => {
    expect(systemdScheduleTargetFor({ ...input, systemdRunning: false })).toEqual({
      ok: false,
      unavailable: expect.stringMatching(/doesn't run systemd/),
    });
  });
});

describe("unit names", () => {
  it("name one set of units per profile", () => {
    const digest = createHash("sha256").update(USER_DATA).digest("hex").slice(0, 12);
    expect(BASE).toBe(`daintree-schedules-${digest}`);
    expect(UNITS).toEqual({
      timer: `${BASE}.timer`,
      launcher: `${BASE}.service`,
      app: `${BASE}-app.service`,
    });
    expect(scheduleSystemdUnitBase("/home/someone/.config/Daintree-dev")).not.toBe(BASE);
  });
});

describe("buildScheduleAppUnit", () => {
  const execStart = (unit: string) =>
    unit.split("\n").find((line) => line.startsWith("ExecStart="));

  it("runs this install with the profile and the due-schedules switch, quoted for systemd", () => {
    const unit = buildScheduleAppUnit({
      ...DEB,
      executable: "/home/some one/100%/$HOME/daintree",
    });
    expect(execStart(unit)).toBe(
      `ExecStart="/home/some one/100%%/$$HOME/daintree" "--user-data-dir=${USER_DATA}" "--run-due-schedules"`
    );
    expect(unit).not.toMatch(/^Restart=/m);
    expect(unit).not.toMatch(/^\[Install\]/m);
  });

  it("gives a dev build's Electron binary its app folder, and its --no-sandbox", () => {
    expect(
      execStart(
        buildScheduleAppUnit({
          ...DEB,
          executable: "/src/daintree/node_modules/electron/dist/electron",
          appPath: "/src/daintree",
          noSandbox: true,
        })
      )
    ).toBe(
      `ExecStart="/src/daintree/node_modules/electron/dist/electron" "/src/daintree" "--no-sandbox" "--user-data-dir=${USER_DATA}" "--run-due-schedules"`
    );
  });

  it("keeps extract-and-run for an AppImage without FUSE, and asks Daintree itself to quit", () => {
    const unit = buildScheduleAppUnit({ ...DEB, appImageExtractAndRun: true });
    expect(unit).toMatch(/^Environment=APPIMAGE_EXTRACT_AND_RUN=1$/m);
    expect(unit).toMatch(/^ExecStop="\/bin\/sh" "-c" /m);
    expect(buildScheduleAppUnit(DEB)).not.toMatch(/APPIMAGE_EXTRACT_AND_RUN|ExecStop=/);
  });

  it("never waits for a display itself: only the launcher starts it", () => {
    expect(buildScheduleAppUnit(DEB)).not.toMatch(/ExecStartPre=|show-environment/);
  });
});

describe("buildScheduleLauncherUnit", () => {
  it("waits for a desktop session with no time limit, then asks for the app unit and ends", () => {
    const unit = buildScheduleLauncherUnit(UNITS);
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).toMatch(/^TimeoutStartSec=infinity$/m);
    expect(unit).toMatch(/^ExecStartPre="\/bin\/sh" "-c" /m);
    expect(unit).toMatch(
      new RegExp(`^ExecStart="systemctl" "--user" "start" "--no-block" "${APP}"$`, "m")
    );
    expect(unit).not.toMatch(/^\[Install\]/m);
  });
});

describe("buildScheduleTimerUnit", () => {
  it("holds one OnCalendar line per spec, catches up after downtime and fires on the second", () => {
    const unit = buildScheduleTimerUnit({
      units: UNITS,
      specs: scheduleTimerSpecs([NINE, HOURLY, NINE], "Europe/London", ZONE_KNOWN),
    });
    expect(unit.split("\n").filter((line) => line.startsWith("OnCalendar="))).toEqual([
      "OnCalendar=*-*-* *:30:00 Europe/London",
      "OnCalendar=*-*-* 09:00:00 Europe/London",
    ]);
    expect(unit).toMatch(/^Persistent=true$/m);
    expect(unit).toMatch(/^AccuracySec=1s$/m);
    // The launcher, never Daintree's own unit.
    expect(unit).toMatch(new RegExp(`^Unit=${LAUNCHER}$`, "m"));
    expect(unit).toMatch(/^\[Install\]\nWantedBy=timers\.target$/m);
  });

  it("leaves out a schedule systemd can't start", () => {
    expect(
      scheduleTimerSpecs(
        [NINE, { cron: "0 9 * * *", timeZone: "Asia/Tokyo" }],
        "Europe/London",
        ZONE_KNOWN
      )
    ).toEqual(["*-*-* 09:00:00 Europe/London"]);
  });

  it("leaves the zone to the user manager when the time zone database lacks its name", () => {
    const asked: string[] = [];
    expect(
      scheduleTimerSpecs([NINE], "Europe/London", (zone) => {
        asked.push(zone);
        return false;
      })
    ).toEqual(["*-*-* 09:00:00"]);
    expect(asked).toEqual(["Europe/London"]);
  });
});

describe("parseUnitStates", () => {
  it("reads each unit's block by its id", () => {
    const states = parseUnitStates(
      "Id=b.service\nLoadState=loaded\nNeedDaemonReload=yes\n\nId=a.timer\nActiveState=active\nUnitFileState=enabled\n",
      ["a.timer", "b.service"]
    );
    expect(states?.get("a.timer")).toEqual({
      loadState: "",
      activeState: "active",
      unitFileState: "enabled",
      needDaemonReload: false,
    });
    expect(states?.get("b.service")?.needDaemonReload).toBe(true);
  });

  it("says nothing when a unit is missing from the answer", () => {
    expect(
      parseUnitStates("Id=a.timer\nActiveState=active\n", ["a.timer", "b.service"])
    ).toBeNull();
  });
});

describe("createSystemdScheduleJob", () => {
  it("installs Daintree's unit, the launcher, then the timer, and reloads, enables and starts it", async () => {
    const events: string[] = [];
    const files = memoryFs({}, events);
    const systemd = fakeSystemd(files.files, { events });
    const adapter = job({ files, systemd });

    await adapter.sync([NINE], "Europe/London", { reload: false });

    expect(events).toEqual([
      `write ${APP}`,
      `write ${LAUNCHER}`,
      `write ${TIMER}`,
      "daemon-reload",
      `enable ${TIMER}`,
      `start ${TIMER}`,
    ]);
    expect(await adapter.observe([NINE], "Europe/London")).toEqual({
      installed: true,
      current: true,
      loaded: true,
    });
  });

  it("does nothing while the timer is current, loaded and waiting", async () => {
    const { loaded, ...initial } = installed();
    const events: string[] = [];
    const files = memoryFs(initial, events);
    const systemd = fakeSystemd(files.files, { events, loaded, active: true });

    await job({ files, systemd }).sync([NINE], "Europe/London", { reload: false });

    expect(events).toEqual([]);
  });

  it("rewrites only what changed and never touches Daintree's own unit", async () => {
    const { loaded, ...initial } = installed();
    const events: string[] = [];
    const files = memoryFs(initial, events);
    const systemd = fakeSystemd(files.files, { events, loaded, active: true });

    await job({ files, systemd }).sync([NINE, HOURLY], "Europe/London", { reload: false });

    expect(events).toEqual([
      `write ${TIMER}`,
      "daemon-reload",
      `enable ${TIMER}`,
      `start ${TIMER}`,
    ]);
    expect(
      systemd.calls.filter(
        (call) => call[0] !== "show" && (call.includes(APP) || call.includes(LAUNCHER))
      )
    ).toEqual([]);
  });

  it("restarts the timer for a repair, even when it reads current", async () => {
    const { loaded, ...initial } = installed();
    const events: string[] = [];
    const files = memoryFs(initial, events);
    const systemd = fakeSystemd(files.files, { events, loaded, active: true });

    await job({ files, systemd }).sync([NINE], "Europe/London", { reload: true });

    expect(events).toEqual(["daemon-reload", `enable ${TIMER}`, `restart ${TIMER}`]);
  });

  it("reloads a timer whose file changed under it", async () => {
    const { loaded, ...initial } = installed();
    const files = memoryFs(initial);
    const systemd = fakeSystemd(files.files, {
      loaded: { ...loaded, [TIMER]: "[Timer]\nOnCalendar=*-*-* 03:00:00\n" },
      active: true,
    });
    const adapter = job({ files, systemd });
    expect(await adapter.observe([NINE], "Europe/London")).toMatchObject({
      current: true,
      loaded: false,
    });

    await adapter.sync([NINE], "Europe/London", { reload: false });

    expect(systemd.loaded.get(TIMER)).toBe(initial[TIMER_FILE]);
    expect(await adapter.observe([NINE], "Europe/London")).toMatchObject({ loaded: true });
  });

  it("starts a timer that was stopped, and enables one that was disabled", async () => {
    const { loaded, [WANTS_LINK]: _link, ...initial } = installed();
    const files = memoryFs(initial);
    const systemd = fakeSystemd(files.files, { loaded, active: false });
    const adapter = job({ files, systemd });

    await adapter.sync([NINE], "Europe/London", { reload: false });

    expect(systemd.isActive()).toBe(true);
    expect(files.files.has(WANTS_LINK)).toBe(true);
  });

  it("removes the job when no schedule needs it, leaving a running Daintree alone", async () => {
    const { loaded, ...initial } = installed();
    const events: string[] = [];
    const files = memoryFs(initial, events);
    const systemd = fakeSystemd(files.files, { events, loaded, active: true });
    const adapter = job({ files, systemd });

    await adapter.sync([], "Europe/London", { reload: false });

    expect(events).toEqual([
      `disable --now ${TIMER}`,
      `stop ${LAUNCHER}`,
      `clean --what=state ${TIMER}`,
      `remove ${TIMER}`,
      `remove ${LAUNCHER}`,
      `remove ${APP}`,
      "daemon-reload",
    ]);
    expect(await adapter.observe([], "Europe/London")).toEqual({
      installed: false,
      current: true,
      loaded: false,
    });
  });

  it("stops a launcher still waiting for a desktop session, and reads it until then", async () => {
    const { loaded, [WANTS_LINK]: _link, ...initial } = installed();
    const files = memoryFs(initial);
    const systemd = fakeSystemd(files.files, { loaded, launcherWaiting: true });
    const adapter = job({ files, systemd });
    for (const file of [TIMER_FILE, LAUNCHER_FILE, APP_FILE]) files.files.delete(file);
    expect(await adapter.observe([], "Europe/London")).toMatchObject({ loaded: true });

    await adapter.sync([], "Europe/London", { reload: false });

    expect(systemd.isLauncherWaiting()).toBe(false);
    expect(await adapter.observe([], "Europe/London")).toMatchObject({ loaded: false });
  });

  it("removes the timer's link itself when systemctl can't disable it", async () => {
    const { loaded, ...initial } = installed();
    const files = memoryFs(initial);
    const systemd = fakeSystemd(files.files, {
      loaded,
      active: true,
      fail: { disable: failed("Access denied") },
    });

    await expect(
      job({ files, systemd }).sync([], "Europe/London", { reload: false })
    ).rejects.toThrow("Couldn't stop the systemd timer (systemctl exited 1): Access denied");
    expect([...files.files.keys()]).toEqual([]);
  });

  it("touches nothing when there's no job and none is wanted", async () => {
    const events: string[] = [];
    const files = memoryFs({}, events);
    const systemd = fakeSystemd(files.files, { events });

    await job({ files, systemd }).sync([], "Europe/London", { reload: false });

    expect(events).toEqual([]);
  });

  it("names the step that failed, and doesn't call a timer it couldn't reload current", async () => {
    const files = memoryFs();
    const systemd = fakeSystemd(files.files, {
      fail: { "daemon-reload": failed("Failed to reload daemon: Access denied") },
    });
    const adapter = job({ files, systemd });

    await expect(adapter.sync([NINE], "Europe/London", { reload: false })).rejects.toThrow(
      "Couldn't reload systemd's user units (systemctl exited 1): Failed to reload daemon: Access denied"
    );
    expect(await adapter.observe([NINE], "Europe/London")).toMatchObject({
      installed: true,
      loaded: false,
    });
  });

  it("refuses to call a timer current that systemd didn't take", async () => {
    const files = memoryFs();
    const systemd = fakeSystemd(files.files, { fail: { start: ok() } });

    await expect(
      job({ files, systemd }).sync([NINE], "Europe/London", { reload: false })
    ).rejects.toThrow("systemd didn't take the timer that starts Daintree");
  });

  it("can't say whether the timer is loaded while the user manager doesn't answer", async () => {
    const { loaded: _loaded, ...initial } = installed();
    const files = memoryFs(initial);
    const systemd = fakeSystemd(files.files, { unreachable: true });

    expect(await job({ files, systemd }).observe([NINE], "Europe/London")).toEqual({
      installed: true,
      current: true,
      loaded: null,
    });
  });

  it("touches nothing from a copy that can't install a timer", async () => {
    const { loaded, ...initial } = installed();
    const files = memoryFs(initial);
    const systemd = fakeSystemd(files.files, { loaded, active: true });
    const adapter = job({
      files,
      systemd,
      target: { ok: false, unavailable: "This computer doesn't run systemd" },
    });

    expect(adapter.unavailable).toBe("This computer doesn't run systemd");
    await expect(adapter.sync([], "Europe/London", { reload: false })).rejects.toThrow(
      "This computer doesn't run systemd"
    );
    expect(files.files.size).toBe(4);
  });
});

describe("followAppImageMove", () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) nodeFs.rmSync(home, { recursive: true, force: true });
    home = null;
  });

  function onDisk(target: SystemdScheduleTarget, content?: string) {
    home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "schedule-job-"));
    const file = nodePath.join(home, ".config", "systemd", "user", APP);
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    nodeFs.writeFileSync(file, content ?? buildScheduleAppUnit(target));
    return file;
  }

  const OLD = "/home/someone/Apps/Daintree-1.0.0.AppImage";
  const NEW = "/home/someone/Apps/Daintree-1.1.0.AppImage";
  const image: SystemdScheduleTarget = { ...DEB, executable: OLD };

  it("points the service this install wrote at the renamed image, and reloads", () => {
    const file = onDisk(image);
    const reloadSync = vi.fn();
    const adapter = job({
      systemd: fakeSystemd(new Map()),
      target: { ok: true, target: image },
      homeDir: home!,
      reloadSync,
    });

    adapter.followAppImageMove({ previous: OLD, next: NEW });

    expect(nodeFs.readFileSync(file, "utf8")).toBe(
      buildScheduleAppUnit({ ...image, executable: NEW })
    );
    expect(reloadSync).toHaveBeenCalledTimes(1);
  });

  it("leaves a service another install wrote", () => {
    const theirs = buildScheduleAppUnit({ ...image, appImageExtractAndRun: true });
    const file = onDisk(image, theirs);
    const reloadSync = vi.fn();
    job({
      systemd: fakeSystemd(new Map()),
      target: { ok: true, target: image },
      homeDir: home!,
      reloadSync,
    }).followAppImageMove({ previous: OLD, next: NEW });

    expect(nodeFs.readFileSync(file, "utf8")).toBe(theirs);
    expect(reloadSync).not.toHaveBeenCalled();
  });

  it("writes the renamed image from then on", async () => {
    onDisk(image);
    const files = memoryFs();
    const unitDir = nodePath.posix.join(home!, ".config", "systemd", "user");
    const systemd = fakeSystemd(files.files, { unitDir });
    const adapter = job({
      files,
      systemd,
      target: { ok: true, target: image },
      homeDir: home!,
    });
    adapter.followAppImageMove({ previous: OLD, next: NEW });

    await adapter.sync([NINE], "Europe/London", { reload: false });

    expect(files.files.get(nodePath.posix.join(unitDir, APP))).toBe(
      buildScheduleAppUnit({ ...image, executable: NEW })
    );
  });
});

describe("DISPLAY_WAIT_SCRIPT", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) nodeFs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /**
   * Runs the script against a systemctl that prints `environments` in turn
   * (the last one from then on), and a sleep that only notes how long it was
   * asked to sleep.
   */
  function wait(environments: string[]) {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "display-wait-"));
    environments.forEach((env, i) => nodeFs.writeFileSync(nodePath.join(dir!, `env${i}`), env));
    nodeFs.writeFileSync(
      nodePath.join(dir, "systemctl"),
      `#!/bin/sh\nn=$(cat "${dir}/count" 2>/dev/null || echo 0)\necho $((n + 1)) > "${dir}/count"\nlast=${environments.length - 1}\n[ "$n" -gt "$last" ] && n=$last\ncat "${dir}/env$n"\n`,
      { mode: 0o755 }
    );
    nodeFs.writeFileSync(nodePath.join(dir, "sleep"), `#!/bin/sh\necho "$1" >> "${dir}/sleeps"\n`, {
      mode: 0o755,
    });
    const result = spawnSync("/bin/sh", ["-c", DISPLAY_WAIT_SCRIPT], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      encoding: "utf8",
      timeout: 20_000,
    });
    const read = (name: string) => {
      try {
        return nodeFs.readFileSync(nodePath.join(dir!, name), "utf8");
      } catch {
        return "";
      }
    };
    return {
      code: result.status,
      looks: Number(read("count")),
      sleeps: read("sleeps").split("\n").filter(Boolean),
    };
  }

  it("goes on at once in a desktop session, on X11 or Wayland", () => {
    expect(wait(["HOME=/home/someone\nDISPLAY=:0\n"])).toMatchObject({ code: 0, looks: 1 });
    expect(wait(["WAYLAND_DISPLAY=wayland-0\n"])).toMatchObject({ code: 0, looks: 1 });
  });

  it("waits for the session to say where its display is, an empty one not counting", () => {
    expect(
      wait(["HOME=/home/someone\n", "DISPLAY=\nXDISPLAY=:0\n", "WAYLAND_DISPLAY=wayland-0\n"])
    ).toMatchObject({ code: 0, looks: 3, sleeps: ["2", "2"] });
  });

  it("keeps waiting past the first minutes, looking less often", () => {
    const quick = Number(/-le (\d+) \]/.exec(DISPLAY_WAIT_SCRIPT)![1]);
    const environments = [...Array<string>(quick + 3).fill("HOME=/home/someone\n"), "DISPLAY=:1\n"];
    const { code, sleeps } = wait(environments);
    expect(code).toBe(0);
    expect(sleeps).toEqual([...Array<string>(quick).fill("2"), "30", "30", "30"]);
  });

  it("is written so systemd hands the shell exactly this script", () => {
    // systemd reads `$$` as `$` and `%%` as `%`, after unquoting the word.
    const line = /^ExecStartPre="\/bin\/sh" "-c" "(.*)"$/m.exec(
      buildScheduleLauncherUnit(UNITS)
    )![1]!;
    expect(line.replace(/\\(.)/g, "$1").replace(/\$\$/g, "$").replace(/%%/g, "%")).toBe(
      DISPLAY_WAIT_SCRIPT
    );
    expect(execFileSync("/bin/sh", ["-n", "-c", DISPLAY_WAIT_SCRIPT]).toString()).toBe("");
  });
});
