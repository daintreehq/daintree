import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RUN_DUE_SCHEDULES_FLAG } from "../../boot/dueScheduleLaunch.js";
import type { CommandResult, CommandRunner } from "../../utils/runCommand.js";
import {
  MAX_TASK_TRIGGERS,
  fitTaskTriggers,
  taskSchedulerTriggersFor,
  type TaskTrigger,
  type TaskTriggerDays,
} from "../../../shared/utils/taskSchedulerTriggers.js";
import type { ScheduleCadence } from "../../../shared/types/scheduledRuns.js";
import { pluralize } from "../../../shared/utils/pluralize.js";
import { MICROSOFT_STORE_UNAVAILABLE } from "./scheduleOsJobContext.js";
import type { ScheduleOsJobAdapter, ScheduleOsJobObservation } from "./ScheduleOsJobService.js";

/**
 * The Windows OS job for schedules set to run when Daintree isn't running
 * (#15993): one Daintree-owned Task Scheduler task whose triggers hold every
 * such schedule's occurrences, and which runs Daintree with
 * `--run-due-schedules`.
 *
 * The task runs the Daintree executable itself. Rewriting or deleting a task
 * leaves a running instance alone, so unlike macOS no launcher stands between
 * them. A Daintree the task started stays inside the task's job until it
 * quits, which is why nothing in the task may ever stop it: no time limit, no
 * battery or idle rules. Each start runs alongside one still going, so a
 * Daintree already running always hears the flag.
 *
 * It only ever registers, reads and deletes its own task, by name.
 */

/** The task's XML is staged in a file for `schtasks`, behind a seam so tests write nothing. */
export interface TaskXmlFs {
  writeFile(file: string, content: Buffer): Promise<void>;
  remove(file: string): Promise<void>;
}

export const nodeTaskXmlFs: TaskXmlFs = {
  async writeFile(file, content) {
    await fs.writeFile(file, content, { flag: "wx" });
  },
  async remove(file) {
    await fs.rm(file, { force: true });
  },
};

const TASK_NAME_PREFIX = "Daintree Schedules";
const FINGERPRINT_PREFIX = "daintree-schedules:";
/** A fixed past date, so the XML depends only on the schedules; a past start counts nothing as missed. */
const START_DATE = "2000-01-01";
/** schtasks answers a read at once; one that doesn't is hung, not slow. */
const QUERY_TIMEOUT_MS = 10_000;
/** Listing every task the user can see takes longer on a busy machine. */
const LIST_TIMEOUT_MS = 20_000;
/** Registering and deleting go through the Task Scheduler service, which can be slow after logon. */
const WRITE_TIMEOUT_MS = 30_000;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
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

export interface TaskSchedulerTarget {
  /** The executable the task runs: Daintree.exe, or electron.exe for a dev build. */
  execPath: string;
  /** Dev builds run Electron against an app folder. */
  appPath: string | null;
  /** This profile, so the task starts the Daintree whose schedules it holds. */
  userDataDir: string;
}

export type TaskSchedulerTargetResult =
  { ok: true; target: TaskSchedulerTarget } | { ok: false; unavailable: string };

/** What the task runs for this copy of Daintree, or why it can't run it. */
export function taskSchedulerTargetFor(input: {
  execPath: string;
  appPath: string | null;
  userDataDir: string;
  windowsStore: boolean;
}): TaskSchedulerTargetResult {
  if (input.windowsStore) return { ok: false, unavailable: MICROSOFT_STORE_UNAVAILABLE };
  return {
    ok: true,
    target: { execPath: input.execPath, appPath: input.appPath, userDataDir: input.userDataDir },
  };
}

/**
 * One task per profile, in the root folder (a standard user can't make a
 * folder): two profiles' schedules are two tasks, and two copies of the app
 * sharing a profile share one, which the copy that ran last points at itself.
 */
export function scheduleTaskName(userDataDir: string): string {
  const digest = createHash("sha256").update(userDataDir).digest("hex").slice(0, 12);
  return `${TASK_NAME_PREFIX} ${digest}`;
}

/** One argument as the Windows C runtime and Chromium read a command line back. */
export function quoteWindowsArgument(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    out += "\\".repeat(ch === '"' ? backslashes * 2 + 1 : backslashes) + ch;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

export function scheduleTaskArguments(target: TaskSchedulerTarget): string[] {
  return [
    ...(target.appPath ? [target.appPath] : []),
    `--user-data-dir=${target.userDataDir}`,
    RUN_DUE_SCHEDULES_FLAG,
  ];
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** An xs:duration Task Scheduler reads, from whole seconds under a day. */
function isoDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `PT${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${seconds ? `${seconds}S` : ""}`;
}

function clock(minuteOfDay: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}:00`;
}

const elements = (names: readonly string[], indexes: readonly number[], offset: number) =>
  indexes.map((index) => `<${names[index - offset]} />`).join("");

function scheduleXml(days: TaskTriggerDays): string {
  switch (days.kind) {
    case "daily":
      return "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>";
    case "weekly":
      return `<ScheduleByWeek><DaysOfWeek>${elements(WEEKDAYS, days.weekdays, 0)}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>`;
    case "monthly":
      return `<ScheduleByMonth><DaysOfMonth>${days.days.map((day) => `<Day>${day}</Day>`).join("")}</DaysOfMonth><Months>${elements(MONTHS, days.months, 1)}</Months></ScheduleByMonth>`;
    case "monthly-weekdays":
      // Weeks 1-4 and Last of a month are every showing of a weekday in it.
      return `<ScheduleByMonthDayOfWeek><Weeks><Week>1</Week><Week>2</Week><Week>3</Week><Week>4</Week><Week>Last</Week></Weeks><DaysOfWeek>${elements(WEEKDAYS, days.weekdays, 0)}</DaysOfWeek><Months>${elements(MONTHS, days.months, 1)}</Months></ScheduleByMonthDayOfWeek>`;
  }
}

function triggerXml(trigger: TaskTrigger): string[] {
  const { repeat } = trigger;
  // In the schema's order: Enabled, StartBoundary, Repetition, then the days.
  return [
    "    <CalendarTrigger>",
    "      <Enabled>true</Enabled>",
    // No zone suffix: the PC's own time, across daylight-saving changes.
    `      <StartBoundary>${START_DATE}T${clock(trigger.startMinute)}</StartBoundary>`,
    ...(repeat
      ? [
          "      <Repetition>",
          `        <Interval>${isoDuration(repeat.everyMinutes * 60)}</Interval>`,
          // A second past the last start: Windows starts one that falls on
          // the end, and the next is at least a minute later.
          `        <Duration>${isoDuration((repeat.count - 1) * repeat.everyMinutes * 60 + 1)}</Duration>`,
          "        <StopAtDurationEnd>false</StopAtDurationEnd>",
          "      </Repetition>",
        ]
      : []),
    `      ${scheduleXml(trigger.days)}`,
    "    </CalendarTrigger>",
  ];
}

export function buildScheduleTaskXml(input: {
  triggers: readonly TaskTrigger[];
  target: TaskSchedulerTarget;
  description: string;
}): string {
  const { target } = input;
  const args = scheduleTaskArguments(target).map(quoteWindowsArgument).join(" ");
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    "  <RegistrationInfo>",
    "    <Author>Daintree</Author>",
    `    <Description>${xmlEscape(input.description)}</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    ...input.triggers.flatMap(triggerXml),
    "  </Triggers>",
    "  <Principals>",
    // Only while the user is logged on, as that user, never elevated: the
    // Daintree it starts needs their desktop for its windows later.
    `    <Principal id="Author">`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    // A start while Daintree runs hands it the flag and exits.
    "    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>",
    // The Daintree started lives in the task's job, so no condition may stop it.
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>true</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    // The default, 7, is below normal for CPU, I/O and memory, and every
    // agent the Daintree it starts launches would inherit it.
    "    <Priority>4</Priority>",
    "  </Settings>",
    `  <Actions Context="Author">`,
    "    <Exec>",
    `      <Command>${xmlEscape(target.execPath)}</Command>`,
    `      <Arguments>${xmlEscape(args)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(path.win32.dirname(target.execPath))}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** `schtasks /Create /XML` reads only UTF-16 (with its byte order mark) or the ANSI code page. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

/** Every eligible schedule's triggers, each written once, in a stable order. */
export function scheduleTaskTriggers(
  cadences: readonly Pick<ScheduleCadence, "cron" | "timeZone">[],
  systemTimeZone: string
): TaskTrigger[] {
  const fit = fitTaskTriggers(
    cadences.map((cadence) => {
      const result = taskSchedulerTriggersFor(cadence, systemTimeZone);
      return result.ok ? result.triggers : [];
    })
  );
  if (fit.reasons.some((reason) => reason !== null)) {
    throw new Error(
      `The schedules need more than the ${pluralize(MAX_TASK_TRIGGERS, "trigger")} a task holds`
    );
  }
  return [...fit.triggers];
}

interface DesiredTask {
  xml: string;
  fingerprint: string;
}

interface SeenTask {
  present: boolean;
  fingerprint: string | null;
  enabled: boolean;
}

const FINGERPRINT = new RegExp(`\\[${FINGERPRINT_PREFIX}([0-9a-f]{64})\\]`);

/**
 * What a read-back says, from plain ASCII markers only: `schtasks` writes in
 * the console's code page and normalizes the XML it stores, so the rest
 * can't be compared byte for byte. A stray NUL from a UTF-16 reading is
 * dropped first.
 */
export function readScheduleTask(output: string): Omit<SeenTask, "present"> {
  const xml = output.replaceAll("\u0000", "");
  const settings = /<Settings>([\s\S]*?)<\/Settings>/.exec(xml)?.[1] ?? "";
  return {
    fingerprint: FINGERPRINT.exec(xml)?.[1] ?? null,
    // The task's own switch; a missing one is Windows' default, on.
    enabled: !/<Enabled>\s*false\s*<\/Enabled>/.test(settings),
  };
}

function describeSchtasks(step: string, result: CommandResult): string {
  if (result.failure === "not-found") return `${step}: schtasks isn't available`;
  if (result.failure === "timeout") return `${step}: schtasks didn't answer`;
  const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/)[0] ?? "";
  return `${step}${result.code !== null ? ` (schtasks exited ${result.code})` : ""}${detail ? `: ${detail}` : ""}`;
}

export function createTaskSchedulerScheduleJob(deps: {
  userDataDir: string;
  target: TaskSchedulerTargetResult;
  run: CommandRunner;
  /** `%SystemRoot%`, so `schtasks.exe` is never looked up on the PATH. */
  systemRoot: string;
  tempDir: string;
  fs?: TaskXmlFs;
}): ScheduleOsJobAdapter {
  const files = deps.fs ?? nodeTaskXmlFs;
  const name = scheduleTaskName(deps.userDataDir);
  const schtasks = path.win32.join(deps.systemRoot, "System32", "schtasks.exe");
  const target = deps.target.ok ? deps.target.target : null;

  const desiredTask = (
    cadences: readonly Pick<ScheduleCadence, "cron" | "timeZone">[],
    systemTimeZone: string
  ): DesiredTask | null => {
    const triggers = scheduleTaskTriggers(cadences, systemTimeZone);
    if (triggers.length === 0 || !target) return null;
    // The fingerprint covers everything written but itself, so a changed
    // schedule, app location or setting reads stale.
    const fingerprint = createHash("sha256")
      .update(buildScheduleTaskXml({ triggers, target, description: "" }))
      .digest("hex");
    const description = `Starts Daintree without a window for its schedules set to run when it isn't running. Daintree keeps this task up to date. [${FINGERPRINT_PREFIX}${fingerprint}]`;
    return { xml: buildScheduleTaskXml({ triggers, target, description }), fingerprint };
  };

  /**
   * The task as it stands. A read that fails exits 1 whether the task is
   * missing or refused, in the user's language, so the task list settles
   * which; a task that can't be read is never taken as missing.
   */
  const query = async (): Promise<SeenTask> => {
    const result = await deps.run(schtasks, ["/Query", "/TN", name, "/XML"], {
      timeoutMs: QUERY_TIMEOUT_MS,
    });
    if (result.code === 0) return { present: true, ...readScheduleTask(result.stdout) };
    const unreadable = new Error(describeSchtasks("Couldn't read the Windows task", result));
    if (result.failure) throw unreadable;
    const list = await deps.run(schtasks, ["/Query", "/FO", "CSV", "/NH"], {
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const listed = list.stdout
      .replaceAll("\u0000", "")
      .split(/\r?\n/)
      .some((line) => line.startsWith(`"\\${name}"`));
    if (list.code !== 0 || listed) throw unreadable;
    return { present: false, fingerprint: null, enabled: false };
  };

  const register = async (desired: DesiredTask): Promise<void> => {
    const file = path.join(deps.tempDir, `daintree-schedules-${randomUUID()}.xml`);
    let result: CommandResult;
    try {
      await files.writeFile(file, encodeTaskXml(desired.xml));
      result = await deps.run(schtasks, ["/Create", "/TN", name, "/XML", file, "/F"], {
        timeoutMs: WRITE_TIMEOUT_MS,
      });
    } finally {
      await files.remove(file).catch(() => {});
    }
    // Seen registered, from this content and switched on, or it didn't happen.
    const seen = await query();
    if (seen.present && seen.enabled && seen.fingerprint === desired.fingerprint) return;
    throw new Error(describeSchtasks("Couldn't register the Windows task", result));
  };

  const remove = async (): Promise<void> => {
    const result = await deps.run(schtasks, ["/Delete", "/TN", name, "/F"], {
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    if (!(await query()).present) return;
    throw new Error(describeSchtasks("Couldn't remove the Windows task", result));
  };

  return {
    kind: "task-scheduler",
    unavailable: deps.target.ok ? null : deps.target.unavailable,

    async sync(cadences, systemTimeZone, options) {
      // A copy that can't point a task at itself leaves the one registered alone.
      if (!deps.target.ok) throw new Error(deps.target.unavailable);
      const desired = desiredTask(cadences, systemTimeZone);
      const seen = await query();
      if (desired === null) {
        if (seen.present) await remove();
        return;
      }
      if (
        !options.reload &&
        seen.present &&
        seen.enabled &&
        seen.fingerprint === desired.fingerprint
      ) {
        return;
      }
      // Registering over the task replaces it whole, switched on, and leaves
      // a Daintree it started running.
      await register(desired);
    },

    async observe(cadences, systemTimeZone): Promise<ScheduleOsJobObservation> {
      const desired = desiredTask(cadences, systemTimeZone);
      const seen = await query();
      return {
        installed: seen.present,
        current: desired === null ? !seen.present : seen.fingerprint === desired.fingerprint,
        loaded: seen.present && seen.enabled,
      };
    },
  };
}
