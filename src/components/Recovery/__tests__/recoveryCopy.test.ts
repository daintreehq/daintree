import { describe, it, expect } from "vitest";
import type { CrashType } from "@shared/types/pty-host";
import {
  HOST_CRASH_BANNER_COPY,
  HOST_CRASH_RECOVERING_COPY,
  SAFE_MODE_BANNER_COPY,
  getHostCrashBannerCopy,
  getRestoreConfirmationTitle,
} from "../recoveryCopy";

describe("HOST_CRASH_BANNER_COPY", () => {
  const cases: Array<[CrashType, string, RegExp]> = [
    [
      "OUT_OF_MEMORY",
      "Terminal service ran out of memory",
      /exhausted memory.+Close unused terminals/,
    ],
    [
      "SIGNAL_TERMINATED",
      "Terminal service was terminated",
      /OS or a watchdog.+Restart the service/,
    ],
    [
      "ASSERTION_FAILURE",
      "Terminal service hit an assertion failure",
      /crashed three times in a row/,
    ],
    [
      "CLEAN_EXIT",
      "Terminal service stopped unexpectedly",
      /exited without an error but wasn't asked to/,
    ],
    ["UNKNOWN_CRASH", "Terminal service crashed", /stopped after three auto-restart attempts/],
  ];

  it.each(cases)("maps %s to the expected title and description", (type, title, descRe) => {
    expect(HOST_CRASH_BANNER_COPY[type].title).toBe(title);
    expect(HOST_CRASH_BANNER_COPY[type].description).toMatch(descRe);
  });

  it("falls back to UNKNOWN_CRASH copy when crashType is null", () => {
    expect(getHostCrashBannerCopy(null)).toBe(HOST_CRASH_BANNER_COPY.UNKNOWN_CRASH);
  });

  it("returns the matching entry for a non-null crashType", () => {
    expect(getHostCrashBannerCopy("OUT_OF_MEMORY")).toBe(HOST_CRASH_BANNER_COPY.OUT_OF_MEMORY);
  });
});

describe("HOST_CRASH_RECOVERING_COPY", () => {
  it("matches the rendered recovering-banner strings byte-for-byte", () => {
    expect(HOST_CRASH_RECOVERING_COPY.title).toBe("Terminal service restarting");
    expect(HOST_CRASH_RECOVERING_COPY.description).toBe(
      "The terminal backend stopped and is restarting automatically."
    );
  });
});

describe("SAFE_MODE_BANNER_COPY", () => {
  it("matches the rendered safe-mode title byte-for-byte", () => {
    expect(SAFE_MODE_BANNER_COPY.title).toBe("Safe mode — panels weren't restored");
  });
});

describe("getRestoreConfirmationTitle", () => {
  it("returns the static title when there are no suspect panels", () => {
    expect(getRestoreConfirmationTitle(0)).toBe("Session recovered after unexpected exit.");
  });

  it("pluralises panel/panels by suspectCount", () => {
    expect(getRestoreConfirmationTitle(1)).toBe(
      "Session recovered after unexpected exit — 1 panel created near the crash may be affected."
    );
    expect(getRestoreConfirmationTitle(3)).toBe(
      "Session recovered after unexpected exit — 3 panels created near the crash may be affected."
    );
  });
});
