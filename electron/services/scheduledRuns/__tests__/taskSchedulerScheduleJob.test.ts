import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { nextCronOccurrence, parseCron } from "../../../../shared/utils/cron.js";
import type { CommandResult } from "../../../utils/runCommand.js";
import { MICROSOFT_STORE_UNAVAILABLE } from "../scheduleOsJobContext.js";
import {
  buildScheduleTaskXml,
  createTaskSchedulerScheduleJob,
  encodeTaskXml,
  quoteWindowsArgument,
  readScheduleTask,
  scheduleTaskName,
  scheduleTaskTriggers,
  taskSchedulerTargetFor,
  type TaskSchedulerTarget,
  type TaskSchedulerTargetResult,
  type TaskXmlFs,
} from "../taskSchedulerScheduleJob.js";

const USER_DATA = "C:\\Users\\Some One\\AppData\\Roaming\\Daintree";
const EXE = "C:\\Users\\Some One\\AppData\\Local\\Programs\\Daintree\\Daintree.exe";
const NAME = scheduleTaskName(USER_DATA);
const SCHTASKS = "C:\\Windows\\System32\\schtasks.exe";
const TEMP = "C:\\Temp";
const ZONE = "Europe/London";

const TARGET: TaskSchedulerTargetResult = taskSchedulerTargetFor({
  execPath: EXE,
  appPath: null,
  userDataDir: USER_DATA,
  windowsStore: false,
});

const NINE = { cron: "0 9 * * *", timeZone: ZONE };
const WORKDAY = { cron: "*/15 9-17 * * 1-5", timeZone: ZONE };

function parse(xml: string): Document {
  const doc = new new JSDOM().window.DOMParser().parseFromString(xml, "application/xml");
  const error = doc.getElementsByTagName("parsererror")[0];
  if (error) throw new Error(`Malformed XML: ${error.textContent}`);
  return doc;
}

const text = (root: Document | Element, tag: string) =>
  [...root.getElementsByTagName(tag)].map((node) => node.textContent);

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY_MS = 86_400_000;

/** The child elements of a node, by name, in document order. */
const names = (node: Element | undefined) => [...(node?.children ?? [])].map((n) => n.tagName);

/** An xs:duration under a day, in seconds. */
function seconds(duration: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
  if (!match) throw new Error(`unread duration ${duration}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/** Whether a calendar trigger's days include this UTC day, read from the XML Windows gets. */
function startsOn(trigger: Element, date: Date): boolean {
  const child = (name: string) => [...trigger.children].find((n) => n.tagName === name);
  const listed = (parent: Element | undefined, tag: string) =>
    names(parent?.getElementsByTagName(tag)[0]);
  const weekday = WEEKDAY_NAMES[date.getUTCDay()]!;
  const month = MONTH_NAMES[date.getUTCMonth()]!;
  const byDay = child("ScheduleByDay");
  if (byDay) return text(byDay, "DaysInterval")[0] === "1";
  const byWeek = child("ScheduleByWeek");
  if (byWeek) {
    expect(text(byWeek, "WeeksInterval")).toEqual(["1"]);
    return listed(byWeek, "DaysOfWeek").includes(weekday);
  }
  const byMonth = child("ScheduleByMonth");
  if (byMonth) {
    return (
      listed(byMonth, "Months").includes(month) &&
      text(byMonth, "Day").includes(String(date.getUTCDate()))
    );
  }
  const byWeekday = child("ScheduleByMonthDayOfWeek")!;
  if (!listed(byWeekday, "Months").includes(month)) return false;
  if (!listed(byWeekday, "DaysOfWeek").includes(weekday)) return false;
  // Week n is the nth showing of the weekday in the month; Last is its last.
  const showing = Math.ceil(date.getUTCDate() / 7);
  const last =
    date.getUTCDate() + 7 >
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const weeks = text(byWeekday, "Week");
  return weeks.includes(String(showing)) || (last && weeks.includes("Last"));
}

/**
 * Task Scheduler's reading of the registered XML in a zone with no clock
 * changes: each trigger starts at its StartBoundary's time on its days, then
 * every Interval while the elapsed time is at most Duration.
 */
function xmlFirings(xml: string, from: number, days: number): number[] {
  const doc = parse(xml);
  const triggers = [...doc.getElementsByTagName("CalendarTrigger")];
  expect(triggers.length).toBeLessThanOrEqual(48);
  const out: number[] = [];
  for (let day = 0; day < days; day++) {
    const start = from + day * DAY_MS;
    const minutes = new Set<number>();
    for (const trigger of triggers) {
      // The schema's sequence for a trigger, then one kind of days.
      const order = names(trigger);
      expect(order.slice(0, 2)).toEqual(["Enabled", "StartBoundary"]);
      expect(order.slice(2, -1)).toEqual(order.length === 4 ? ["Repetition"] : []);
      expect(order.at(-1)).toMatch(/^ScheduleBy/);
      if (!startsOn(trigger, new Date(start))) continue;
      const [, hh, mm] = /T(\d\d):(\d\d):00$/.exec(text(trigger, "StartBoundary")[0]!)!;
      const first = Number(hh) * 60 + Number(mm);
      const repetition = trigger.getElementsByTagName("Repetition")[0];
      const every = repetition ? seconds(text(repetition, "Interval")[0]!) : Infinity;
      const span = repetition ? seconds(text(repetition, "Duration")[0]!) : 0;
      for (let offset = 0; offset <= span; offset += every) {
        const minute = first + offset / 60;
        // A repetition past midnight would start on the next day too.
        expect(minute).toBeLessThan(1440);
        minutes.add(minute);
      }
    }
    for (const minute of [...minutes].sort((a, b) => a - b)) out.push(start + minute * 60_000);
  }
  return out;
}

function cronFirings(expression: string, from: number, days: number): number[] {
  const parsed = parseCron(expression);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const end = from + days * DAY_MS;
  const out: number[] = [];
  for (let at = nextCronOccurrence(parsed.cron, "UTC", from - 1); at !== null && at < end;) {
    out.push(at);
    at = nextCronOccurrence(parsed.cron, "UTC", at);
  }
  return out;
}

function decode(content: Buffer): string {
  expect([...content.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  return content.subarray(2).toString("utf16le");
}

/** A Task Scheduler that stores what `/Create` was given and hands it back normalized. */
function fakeSchtasks(options: { registered?: string } = {}) {
  const files = new Map<string, Buffer>();
  const commands: string[][] = [];
  let task: string | null = options.registered ?? null;
  let refuseRead = false;
  let failCreate = false;
  let failDelete = false;
  let listFails = false;
  let missing = false;

  const fs: TaskXmlFs = {
    writeFile: vi.fn(async (file: string, content: Buffer) => {
      if (files.has(file)) throw new Error("EEXIST");
      files.set(file, content);
    }),
    remove: vi.fn(async (file: string) => {
      files.delete(file);
    }),
  };

  const result = (code: number, stdout = "", stderr = ""): CommandResult => ({
    code,
    stdout,
    stderr,
  });

  const run = vi.fn(async (file: string, args: readonly string[]): Promise<CommandResult> => {
    commands.push([...args]);
    expect(file).toBe(SCHTASKS);
    if (missing) return { code: null, stdout: "", stderr: "", failure: "not-found" };
    const [verb] = args;
    if (verb === "/Query" && args.includes("/XML")) {
      expect(args).toEqual(["/Query", "/TN", NAME, "/XML"]);
      if (refuseRead) return result(1, "", "ERROR: Access is denied.\r\n");
      if (task === null) {
        return result(1, "", "ERROR: The system cannot find the file specified.\r\n");
      }
      // Windows stores its own rendering: other whitespace, a principal it filled in.
      return result(
        0,
        task
          .replace(/\r\n\s*/g, "\r\n  ")
          .replace("<LogonType>", "<UserId>S-1-5-21-1</UserId><LogonType>")
      );
    }
    if (verb === "/Query") {
      expect(args).toEqual(["/Query", "/FO", "CSV", "/NH"]);
      if (listFails) return result(1, "", "ERROR: The Task Scheduler service is busy.\r\n");
      const rows = [`"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","N/A","Ready"`];
      if (task !== null || refuseRead) rows.push(`"\\${NAME}","N/A","Ready"`);
      return result(0, `\r\n${rows.join("\r\n")}\r\n`);
    }
    if (verb === "/Create") {
      const xmlFile = args[args.indexOf("/XML") + 1]!;
      expect(args).toEqual(["/Create", "/TN", NAME, "/XML", xmlFile, "/F"]);
      if (failCreate) return result(1, "", "ERROR: Access is denied.\r\n");
      task = decode(files.get(xmlFile)!);
      return result(0, `SUCCESS: The scheduled task "${NAME}" has successfully been created.`);
    }
    if (verb === "/Delete") {
      expect(args).toEqual(["/Delete", "/TN", NAME, "/F"]);
      if (failDelete) return result(1, "", "ERROR: Access is denied.\r\n");
      task = null;
      return result(0, "SUCCESS");
    }
    throw new Error(`unexpected schtasks ${args.join(" ")}`);
  });

  return {
    fs,
    run,
    files,
    commands,
    verbs: () => commands.map((args) => (args.includes("/FO") ? "/List" : args[0])),
    task: () => task,
    disable: () => {
      task = task!.replace(
        /(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/,
        "$1<Enabled>false</Enabled>"
      );
    },
    refuseRead: (value: boolean) => (refuseRead = value),
    failCreate: (value: boolean) => (failCreate = value),
    failDelete: (value: boolean) => (failDelete = value),
    failList: (value: boolean) => (listFails = value),
    vanish: () => (missing = true),
  };
}

function job(schtasks: ReturnType<typeof fakeSchtasks>, target = TARGET) {
  return createTaskSchedulerScheduleJob({
    userDataDir: USER_DATA,
    target,
    run: schtasks.run,
    systemRoot: "C:\\Windows",
    tempDir: TEMP,
    fs: schtasks.fs,
  });
}

describe("taskSchedulerTargetFor", () => {
  it("runs this executable for this profile", () => {
    expect(TARGET).toEqual({
      ok: true,
      target: { execPath: EXE, appPath: null, userDataDir: USER_DATA },
    });
  });

  it("refuses a Microsoft Store build, which Windows won't start by path", () => {
    expect(
      taskSchedulerTargetFor({
        execPath:
          "C:\\Program Files\\WindowsApps\\GregPriday.Daintree_1.0.0.0_x64__abc\\app\\Daintree.exe",
        appPath: null,
        userDataDir: USER_DATA,
        windowsStore: true,
      })
    ).toEqual({ ok: false, unavailable: MICROSOFT_STORE_UNAVAILABLE });
  });
});

describe("scheduleTaskName", () => {
  it("names the task by twelve hex digits of its profile's path", () => {
    const digest = createHash("sha256").update(USER_DATA).digest("hex").slice(0, 12);
    expect(NAME).toBe(`Daintree Schedules ${digest}`);
    expect(scheduleTaskName(`${USER_DATA}-dev`)).not.toBe(NAME);
  });
});

describe("quoteWindowsArgument", () => {
  /** The C runtime's reading of one argument, as Chromium also reads it. */
  function unquote(quoted: string): string {
    if (!quoted.startsWith('"')) return quoted;
    let out = "";
    let i = 1;
    while (i < quoted.length) {
      let backslashes = 0;
      while (quoted[i] === "\\") {
        backslashes++;
        i++;
      }
      if (quoted[i] === '"') {
        out += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 0) return out;
        out += '"';
      } else {
        out += "\\".repeat(backslashes) + (quoted[i] ?? "");
      }
      i++;
    }
    throw new Error(`unterminated ${quoted}`);
  }

  it.each([
    "--run-due-schedules",
    `--user-data-dir=${USER_DATA}`,
    "C:\\path with space\\",
    'a "quoted" word',
    "C:\\Users\\Zoë Ünal\\Daintree",
    "",
  ])("reads %j back exactly", (arg) => {
    expect(unquote(quoteWindowsArgument(arg))).toBe(arg);
  });

  it("leaves a plain argument bare", () => {
    expect(quoteWindowsArgument("--run-due-schedules")).toBe("--run-due-schedules");
  });
});

describe("buildScheduleTaskXml", () => {
  const target = (TARGET as { target: TaskSchedulerTarget }).target;
  const build = (cadences = [WORKDAY], over: Partial<TaskSchedulerTarget> = {}) =>
    parse(
      buildScheduleTaskXml({
        triggers: scheduleTaskTriggers(cadences, ZONE),
        target: { ...target, ...over },
        description: "About <this> & that",
      })
    );

  it("runs only while the user is logged on, as them, never elevated", () => {
    const doc = build();
    expect(text(doc, "LogonType")).toEqual(["InteractiveToken"]);
    expect(text(doc, "RunLevel")).toEqual(["LeastPrivilege"]);
    expect(doc.getElementsByTagName("UserId")).toHaveLength(0);
  });

  it("catches up a missed start, wakes the PC, and never stops the Daintree it started", () => {
    const doc = build();
    const settings = doc.getElementsByTagName("Settings")[0]!;
    const setting = (tag: string) =>
      [...settings.children].find((node) => node.tagName === tag)?.textContent;
    expect(setting("StartWhenAvailable")).toBe("true");
    expect(setting("WakeToRun")).toBe("true");
    expect(setting("MultipleInstancesPolicy")).toBe("Parallel");
    expect(setting("DisallowStartIfOnBatteries")).toBe("false");
    expect(setting("StopIfGoingOnBatteries")).toBe("false");
    expect(setting("RunOnlyIfIdle")).toBe("false");
    expect(setting("RunOnlyIfNetworkAvailable")).toBe("false");
    expect(setting("ExecutionTimeLimit")).toBe("PT0S");
    expect(setting("Enabled")).toBe("true");
    expect(text(doc, "StopOnIdleEnd")).toEqual(["false"]);
    // Below 7, so neither Daintree nor its agents run at a lowered priority.
    expect(Number(setting("Priority"))).toBeLessThan(7);
  });

  it("runs this executable with the profile and the due-schedules switch, from its folder", () => {
    const doc = build();
    expect(text(doc, "Command")).toEqual([EXE]);
    expect(text(doc, "Arguments")).toEqual([`"--user-data-dir=${USER_DATA}" --run-due-schedules`]);
    expect(text(doc, "WorkingDirectory")).toEqual([
      "C:\\Users\\Some One\\AppData\\Local\\Programs\\Daintree",
    ]);
  });

  it("passes a dev build's app folder to Electron first, and escapes what it writes", () => {
    const doc = build([NINE], {
      execPath: "C:\\dev\\R&D\\node_modules\\electron\\dist\\electron.exe",
      appPath: "C:\\dev\\R&D",
    });
    expect(text(doc, "Command")).toEqual([
      "C:\\dev\\R&D\\node_modules\\electron\\dist\\electron.exe",
    ]);
    expect(text(doc, "Arguments")[0]).toMatch(/^C:\\dev\\R&D "--user-data-dir=/);
    expect(text(doc, "Description")).toEqual(["About <this> & that"]);
  });

  it("writes a repeating trigger that stops a second after its last start, on the PC's own time", () => {
    const doc = build();
    const trigger = doc.getElementsByTagName("CalendarTrigger")[0]!;
    expect(doc.getElementsByTagName("CalendarTrigger")).toHaveLength(1);
    expect(text(doc, "StartBoundary")).toEqual(["2000-01-01T09:00:00"]);
    expect(text(doc, "Interval")).toEqual(["PT15M"]);
    // 09:00 to 17:45 is 8 h 45 min of starts.
    expect(text(doc, "Duration")).toEqual(["PT8H45M1S"]);
    expect(text(doc, "StopAtDurationEnd")).toEqual(["false"]);
    const week = trigger.getElementsByTagName("ScheduleByWeek")[0]!;
    expect([...week.getElementsByTagName("DaysOfWeek")[0]!.children].map((n) => n.tagName)).toEqual(
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
    );
    expect(text(doc, "WeeksInterval")).toEqual(["1"]);
  });

  it("writes each kind of day Task Scheduler holds", () => {
    const doc = build([
      NINE,
      { cron: "0 6 1,15 3 *", timeZone: ZONE },
      { cron: "0 7 * 1,12 SUN", timeZone: ZONE },
    ]);
    expect(text(doc, "DaysInterval")).toEqual(["1"]);
    const month = doc.getElementsByTagName("ScheduleByMonth")[0]!;
    expect(text(month, "Day")).toEqual(["1", "15"]);
    expect([...month.getElementsByTagName("Months")[0]!.children].map((n) => n.tagName)).toEqual([
      "March",
    ]);
    const weekdays = doc.getElementsByTagName("ScheduleByMonthDayOfWeek")[0]!;
    expect(text(weekdays, "Week")).toEqual(["1", "2", "3", "4", "Last"]);
    expect([...weekdays.getElementsByTagName("Months")[0]!.children].map((n) => n.tagName)).toEqual(
      ["January", "December"]
    );
    expect(doc.getElementsByTagName("Repetition")).toHaveLength(0);
  });

  it.each([
    "0 9 * * *",
    "*/15 9-17 * * 1-5",
    "0 * * * *",
    "*/7 9-17 * * *",
    "0,30 9,12,15 * * *",
    "5 0 1,15 * *",
    "0 9 * 1,6 1",
    "0 9 1 * 1",
    "0 0 29 2 *",
    "15 10 * 3-5 *",
    "30 8,13,17 * * 0,6",
  ])("registers XML that Windows starts at exactly the occurrences of %s", (cron) => {
    const xml = buildScheduleTaskXml({
      triggers: scheduleTaskTriggers([{ cron, timeZone: "UTC" }], "UTC"),
      target,
      description: "",
    });
    // A leap year and the next, from a Monday.
    const from = Date.UTC(2027, 11, 27);
    expect(xmlFirings(xml, from, 2 * 366)).toEqual(cronFirings(cron, from, 2 * 366));
  });

  it("writes a trigger two schedules share once", () => {
    expect(build([NINE, NINE, { ...NINE }]).getElementsByTagName("CalendarTrigger")).toHaveLength(
      1
    );
  });
});

describe("encodeTaskXml", () => {
  it("writes UTF-16 with its byte order mark, as schtasks reads it", () => {
    const xml = `<?xml version="1.0" encoding="UTF-16"?><Task>Zoë</Task>`;
    expect(decode(encodeTaskXml(xml))).toBe(xml);
  });
});

describe("readScheduleTask", () => {
  const xml = (enabled: string) =>
    `<Task><RegistrationInfo><Description>x [daintree-schedules:${"a".repeat(64)}]</Description></RegistrationInfo><Triggers><CalendarTrigger><Enabled>false</Enabled></CalendarTrigger></Triggers><Settings><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd></IdleSettings>${enabled}</Settings></Task>`;

  it("reads the fingerprint and the task's own switch, not a trigger's", () => {
    expect(readScheduleTask(xml("<Enabled>true</Enabled>"))).toEqual({
      fingerprint: "a".repeat(64),
      enabled: true,
    });
    expect(readScheduleTask(xml("<Enabled>false</Enabled>")).enabled).toBe(false);
    expect(readScheduleTask(xml("")).enabled).toBe(true);
  });

  it("reads a UTF-16 answer taken as bytes", () => {
    const wide = Buffer.from(xml("<Enabled>false</Enabled>"), "utf16le").toString("latin1");
    expect(readScheduleTask(wide)).toEqual({ fingerprint: "a".repeat(64), enabled: false });
  });

  it("finds no fingerprint in a task Daintree didn't write", () => {
    expect(readScheduleTask("<Task><Settings /></Task>").fingerprint).toBeNull();
  });
});

describe("createTaskSchedulerScheduleJob", () => {
  it("registers the task from a UTF-16 file it then removes, and sees it registered", async () => {
    const schtasks = fakeSchtasks();
    await job(schtasks).sync([NINE], ZONE, { reload: false });

    expect(schtasks.verbs()).toEqual(["/Query", "/List", "/Create", "/Query"]);
    const create = schtasks.commands[2]!;
    const file = create[create.indexOf("/XML") + 1]!;
    expect(file.startsWith(TEMP)).toBe(true);
    expect(schtasks.fs.remove).toHaveBeenCalledWith(file);
    expect(schtasks.files.size).toBe(0);
    const doc = parse(schtasks.task()!);
    expect(text(doc, "StartBoundary")).toEqual(["2000-01-01T09:00:00"]);
  });

  it("does nothing while the task reads current, however Windows renders it", async () => {
    const schtasks = fakeSchtasks();
    const adapter = job(schtasks);
    await adapter.sync([NINE], ZONE, { reload: false });
    schtasks.commands.length = 0;

    await adapter.sync([NINE], ZONE, { reload: false });
    expect(schtasks.verbs()).toEqual(["/Query"]);
    expect(await adapter.observe([NINE], ZONE)).toEqual({
      installed: true,
      current: true,
      loaded: true,
    });
  });

  it("rewrites it for a changed cadence, a moved app, a switched-off task, and on repair", async () => {
    const schtasks = fakeSchtasks();
    await job(schtasks).sync([NINE], ZONE, { reload: false });

    const creates = async (run: () => Promise<void>) => {
      schtasks.commands.length = 0;
      await run();
      return schtasks.verbs().filter((verb) => verb === "/Create").length;
    };
    expect(await creates(() => job(schtasks).sync([NINE, WORKDAY], ZONE, { reload: false }))).toBe(
      1
    );
    const moved = taskSchedulerTargetFor({
      execPath: "D:\\Daintree\\Daintree.exe",
      appPath: null,
      userDataDir: USER_DATA,
      windowsStore: false,
    });
    // The same schedules from a copy that has moved: only the app changed.
    expect(await job(schtasks).observe([NINE, WORKDAY], ZONE)).toMatchObject({ current: true });
    expect(await job(schtasks, moved).observe([NINE, WORKDAY], ZONE)).toMatchObject({
      current: false,
    });
    expect(
      await creates(() => job(schtasks, moved).sync([NINE, WORKDAY], ZONE, { reload: false }))
    ).toBe(1);
    expect(text(parse(schtasks.task()!), "Command")).toEqual(["D:\\Daintree\\Daintree.exe"]);

    schtasks.disable();
    expect(await job(schtasks, moved).observe([NINE], ZONE)).toMatchObject({ loaded: false });
    expect(await creates(() => job(schtasks, moved).sync([NINE], ZONE, { reload: false }))).toBe(1);
    expect(await creates(() => job(schtasks, moved).sync([NINE], ZONE, { reload: true }))).toBe(1);
    expect(await job(schtasks, moved).observe([NINE], ZONE)).toEqual({
      installed: true,
      current: true,
      loaded: true,
    });
  });

  it("deletes the task when no schedule needs it, and sees it gone", async () => {
    const schtasks = fakeSchtasks();
    const adapter = job(schtasks);
    await adapter.sync([NINE], ZONE, { reload: false });
    schtasks.commands.length = 0;

    await adapter.sync([], ZONE, { reload: false });
    expect(schtasks.verbs()).toEqual(["/Query", "/Delete", "/Query", "/List"]);
    expect(schtasks.task()).toBeNull();
    expect(await adapter.observe([], ZONE)).toEqual({
      installed: false,
      current: true,
      loaded: false,
    });

    schtasks.commands.length = 0;
    await adapter.sync([], ZONE, { reload: false });
    expect(schtasks.verbs()).toEqual(["/Query", "/List"]);
  });

  it("never takes a task it can't read for a missing one", async () => {
    const schtasks = fakeSchtasks();
    const adapter = job(schtasks);
    await adapter.sync([NINE], ZONE, { reload: false });
    schtasks.refuseRead(true);
    schtasks.commands.length = 0;

    await expect(adapter.sync([], ZONE, { reload: false })).rejects.toThrow(
      "Couldn't read the Windows task (schtasks exited 1): ERROR: Access is denied."
    );
    await expect(adapter.sync([WORKDAY], ZONE, { reload: false })).rejects.toThrow(/read/);
    await expect(adapter.observe([], ZONE)).rejects.toThrow(/read/);
    expect(schtasks.verbs()).not.toContain("/Delete");
    expect(schtasks.verbs()).not.toContain("/Create");
  });

  it("can't tell a missing task when the task list can't be read either", async () => {
    const schtasks = fakeSchtasks();
    schtasks.failList(true);
    await expect(job(schtasks).observe([NINE], ZONE)).rejects.toThrow(
      "Couldn't read the Windows task (schtasks exited 1): ERROR: The system cannot find the file specified."
    );
  });

  it("says when schtasks isn't there at all", async () => {
    const schtasks = fakeSchtasks();
    schtasks.vanish();
    await expect(job(schtasks).sync([NINE], ZONE, { reload: false })).rejects.toThrow(
      "Couldn't read the Windows task: schtasks isn't available"
    );
  });

  it("says why registering failed, and still removes its file", async () => {
    const schtasks = fakeSchtasks();
    schtasks.failCreate(true);
    await expect(job(schtasks).sync([NINE], ZONE, { reload: false })).rejects.toThrow(
      "Couldn't register the Windows task (schtasks exited 1): ERROR: Access is denied."
    );
    expect(schtasks.files.size).toBe(0);
    expect(schtasks.task()).toBeNull();
  });

  it("says why a task that should go is still there", async () => {
    const schtasks = fakeSchtasks();
    await job(schtasks).sync([NINE], ZONE, { reload: false });
    schtasks.failDelete(true);
    await expect(job(schtasks).sync([], ZONE, { reload: false })).rejects.toThrow(
      "Couldn't remove the Windows task (schtasks exited 1): ERROR: Access is denied."
    );
  });

  it("reads stale against a task another copy wrote for other schedules", async () => {
    const schtasks = fakeSchtasks();
    await job(schtasks).sync([WORKDAY], ZONE, { reload: false });
    expect(await job(schtasks).observe([NINE], ZONE)).toEqual({
      installed: true,
      current: false,
      loaded: true,
    });
  });

  it("touches nothing from a build that can't register the task, and says why", async () => {
    const schtasks = fakeSchtasks();
    const store = taskSchedulerTargetFor({
      execPath: EXE,
      appPath: null,
      userDataDir: USER_DATA,
      windowsStore: true,
    });
    const adapter = job(schtasks, store);
    expect(adapter.unavailable).toBe(MICROSOFT_STORE_UNAVAILABLE);
    await expect(adapter.sync([NINE], ZONE, { reload: false })).rejects.toThrow(
      MICROSOFT_STORE_UNAVAILABLE
    );
    expect(schtasks.commands).toEqual([]);
  });
});
