import { describe, expect, it } from "vitest";
import { readSystemTimeZone, scheduleOsJobContext } from "../scheduleOsJobContext.js";

describe("readSystemTimeZone", () => {
  it("reads the zone the /etc/localtime link names, on macOS and Linux layouts alike", () => {
    expect(readSystemTimeZone(() => "/var/db/timezone/zoneinfo/Europe/London")).toBe("Europe/London");
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
    expect(scheduleOsJobContext("linux").kind).toBe("systemd-timer");
    expect(scheduleOsJobContext("win32")).toEqual({ kind: null, systemTimeZone: null });
  });
});
