import { afterEach, describe, expect, it } from "vitest";
import { createSchedule } from "../../../../shared/utils/scheduledRuns.js";
import {
  MICROSOFT_STORE_UNAVAILABLE,
  readSystemTimeZone,
  readWindowsTimeZone,
  runWhenClosedWriteIssues,
  scheduleOsJobContext,
} from "../scheduleOsJobContext.js";
import { runWhenClosedIssues } from "../../../../shared/utils/scheduleOsJob.js";

describe("readSystemTimeZone", () => {
  it("reads the zone the /etc/localtime link names, on macOS and Linux layouts alike", () => {
    expect(readSystemTimeZone(() => "/var/db/timezone/zoneinfo/Europe/London")).toBe(
      "Europe/London"
    );
    expect(readSystemTimeZone(() => "../usr/share/zoneinfo/America/New_York")).toBe(
      "America/New_York"
    );
    // NixOS links into its own store.
    expect(readSystemTimeZone(() => "/etc/zoneinfo/Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("falls back to the runtime's zone when the link names none", () => {
    const runtime = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(
      readSystemTimeZone(() => {
        throw Object.assign(new Error("not a link"), { code: "EINVAL" });
      })
    ).toBe(runtime);
    expect(readSystemTimeZone(() => "/usr/share/zoneinfo/Not/AZone")).toBe(runtime);
  });
});

describe("scheduleOsJobContext", () => {
  it("names each platform's job", () => {
    expect(scheduleOsJobContext("darwin").kind).toBe("launch-agent");
    // The zone the timer is checked and written in, read as on macOS.
    const zone = readSystemTimeZone();
    expect(zone).not.toBeNull();
    expect(scheduleOsJobContext("linux")).toEqual({
      kind: "systemd-timer",
      systemTimeZone: zone,
      unavailable: null,
    });
    expect(scheduleOsJobContext("win32", false).kind).toBe("task-scheduler");
    expect(scheduleOsJobContext("freebsd")).toEqual({
      kind: null,
      systemTimeZone: null,
      unavailable: null,
    });
  });
});

describe("readWindowsTimeZone", () => {
  const sydney = () => "Australia/Sydney";

  it("takes the runtime's zone, which follows Windows'", () => {
    expect(readWindowsTimeZone(undefined, sydney)).toBe("Australia/Sydney");
    expect(readWindowsTimeZone("", sydney)).toBe("Australia/Sydney");
  });

  it("doesn't guess while a TZ in the environment moves the runtime's zone", () => {
    expect(readWindowsTimeZone("America/New_York", sydney)).toBeNull();
  });

  it("is unknown when the runtime names no real zone", () => {
    expect(readWindowsTimeZone(undefined, () => "Not/AZone")).toBeNull();
  });
});

describe("scheduleOsJobContext on Windows", () => {
  it("is Task Scheduler on Windows, unavailable only to a Microsoft Store build", () => {
    const zone = readWindowsTimeZone();
    expect(scheduleOsJobContext("win32", false)).toEqual({
      kind: "task-scheduler",
      systemTimeZone: zone,
      unavailable: null,
    });
    expect(scheduleOsJobContext("win32", true)).toEqual({
      kind: "task-scheduler",
      systemTimeZone: zone,
      unavailable: MICROSOFT_STORE_UNAVAILABLE,
    });
  });

  it("refuses the option on a Store build with the reason, so the editor shows it", () => {
    const schedule = createSchedule(
      {
        id: "s1",
        projectId: "p1",
        name: "Nightly",
        launch: { agentId: "claude", prompt: "Go." },
        cron: "0 9 * * *",
        timeZone: "UTC",
        policies: { runWhenClosed: true },
      },
      1
    );
    expect(runWhenClosedIssues(schedule, scheduleOsJobContext("win32", true))).toEqual([
      { path: "policies.runWhenClosed", cronField: null, message: MICROSOFT_STORE_UNAVAILABLE },
    ]);
  });
});

describe("runWhenClosedWriteIssues on this process", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const windowsStore = Object.getOwnPropertyDescriptor(process, "windowsStore");

  function runAs(values: { platform: NodeJS.Platform; windowsStore?: boolean }) {
    Object.defineProperty(process, "platform", { ...platform, value: values.platform });
    Object.defineProperty(process, "windowsStore", {
      configurable: true,
      writable: true,
      value: values.windowsStore,
    });
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    if (windowsStore) Object.defineProperty(process, "windowsStore", windowsStore);
    else delete (process as { windowsStore?: boolean }).windowsStore;
  });

  function nightly(runWhenClosed: boolean) {
    return createSchedule(
      {
        id: "s1",
        projectId: "p1",
        name: "Nightly",
        launch: { agentId: "claude", prompt: "Go." },
        cron: "0 9 * * *",
        timeZone: "UTC",
        policies: { runWhenClosed },
      },
      1
    );
  }

  it("refuses the option from a Microsoft Store build, read from the process", () => {
    runAs({ platform: "win32", windowsStore: true });
    expect(runWhenClosedWriteIssues(nightly(true))).toEqual([
      { path: "policies.runWhenClosed", cronField: null, message: MICROSOFT_STORE_UNAVAILABLE },
    ]);
    // Saving it off is never refused.
    expect(runWhenClosedWriteIssues(nightly(false))).toEqual([]);
  });

  it("doesn't refuse an installed build for its packaging", () => {
    runAs({ platform: "win32" });
    expect(runWhenClosedWriteIssues(nightly(true)).map((issue) => issue.message)).not.toContain(
      MICROSOFT_STORE_UNAVAILABLE
    );
  });
});
