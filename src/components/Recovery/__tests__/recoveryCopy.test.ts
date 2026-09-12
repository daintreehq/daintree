import { describe, it, expect } from "vitest";
import type { CrashType } from "@shared/types/pty-host";
import {
  HOST_CRASH_BANNER_COPY,
  HOST_CRASH_RECOVERING_COPY,
  SAFE_MODE_BANNER_COPY,
  getHostCrashBannerCopy,
  RESTORE_CONFIRMATION_TITLE,
  getRestoreConfirmationDescription,
} from "../recoveryCopy";

describe("HOST_CRASH_BANNER_COPY", () => {
  const cases: Array<[CrashType, string, string]> = [
    [
      "OUT_OF_MEMORY",
      "Terminal service ran out of memory",
      "The terminal backend exhausted memory and gave up after three auto-restart attempts. Close unused terminals before restarting.",
    ],
    [
      "SIGNAL_TERMINATED",
      "Terminal service was terminated",
      "The OS or a watchdog ended the terminal backend three times in a row. Restart the service to continue.",
    ],
    [
      "ASSERTION_FAILURE",
      "Terminal service hit an assertion failure",
      "The terminal backend crashed three times in a row. Restart the service to continue.",
    ],
    [
      "CLEAN_EXIT",
      "Terminal service stopped unexpectedly",
      "The terminal backend exited without an error but wasn't asked to. Restart the service to continue.",
    ],
    [
      "UNKNOWN_CRASH",
      "Terminal service crashed",
      "The terminal backend stopped after three auto-restart attempts. Restart the service to continue.",
    ],
  ];

  it.each(cases)("maps %s to the expected title and description", (type, title, description) => {
    expect(HOST_CRASH_BANNER_COPY[type].title).toBe(title);
    expect(HOST_CRASH_BANNER_COPY[type].description).toBe(description);
  });

  it("falls back to UNKNOWN_CRASH copy when crashType is null", () => {
    expect(getHostCrashBannerCopy(null)).toBe(HOST_CRASH_BANNER_COPY.UNKNOWN_CRASH);
  });

  it.each(cases.map(([type]) => [type] as [CrashType]))(
    "getHostCrashBannerCopy returns the matching entry for %s",
    (type) => {
      expect(getHostCrashBannerCopy(type)).toBe(HOST_CRASH_BANNER_COPY[type]);
    }
  );
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

describe("restore confirmation copy", () => {
  it("keeps the title a noun phrase with no trailing period", () => {
    expect(RESTORE_CONFIRMATION_TITLE.endsWith(".")).toBe(false);
  });

  it("has no description when there are no suspect panels", () => {
    expect(getRestoreConfirmationDescription(0)).toBeUndefined();
  });

  it("pluralises panel/panels by suspectCount", () => {
    expect(getRestoreConfirmationDescription(1)).toBe(
      "1 panel created near the crash may be affected."
    );
    expect(getRestoreConfirmationDescription(2)).toBe(
      "2 panels created near the crash may be affected."
    );
    expect(getRestoreConfirmationDescription(3)).toBe(
      "3 panels created near the crash may be affected."
    );
  });
});
