import { describe, it, expect } from "vitest";
import {
  CRASH_CAUSE_COPY,
  getCrashCauseTitle,
  getCrashCauseDescription,
  getCrashCauseReportLabel,
} from "../crashCauseCopy.js";
import type { CrashCause } from "../../types/ipc/crashRecovery.js";

describe("CRASH_CAUSE_COPY", () => {
  it("has a copy entry for every CrashCause value (exhaustive)", () => {
    const allCauses: CrashCause[] = [
      "uncaught-exception",
      "native-crash",
      "suspended-then-lost",
      "power-loss",
      "external-kill",
      "unknown",
    ];
    for (const cause of allCauses) {
      const copy = CRASH_CAUSE_COPY[cause];
      expect(copy).toBeDefined();
      expect(copy.title).toBeTypeOf("string");
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.title.endsWith(".")).toBe(false); // sentence-case, no trailing period on titles
      expect(copy.description).toBeTypeOf("string");
      expect(copy.description.length).toBeGreaterThan(0);
      expect(copy.reportLabel).toBeTypeOf("string");
      expect(copy.reportLabel.length).toBeGreaterThan(0);
    }
  });

  it("renders the unknown cause with the V1-generic title for log-fallback parity", () => {
    expect(CRASH_CAUSE_COPY.unknown.title).toBe("Daintree closed unexpectedly");
  });

  it("keeps cause-specific titles distinct from the generic fallback", () => {
    const distinctCauses: CrashCause[] = [
      "uncaught-exception",
      "native-crash",
      "suspended-then-lost",
      "power-loss",
      "external-kill",
    ];
    const titles = new Set(distinctCauses.map((c) => CRASH_CAUSE_COPY[c].title));
    expect(titles.size).toBe(distinctCauses.length);
  });
});

describe("getCrashCauseTitle", () => {
  it("returns the title for a known cause", () => {
    expect(getCrashCauseTitle("power-loss")).toBe("Power was interrupted");
    expect(getCrashCauseTitle("external-kill")).toBe("Daintree was forced to close");
  });

  it("falls back to the V1 generic title for undefined", () => {
    expect(getCrashCauseTitle(undefined)).toBe("Daintree closed unexpectedly");
  });

  it("returns the generic title for the 'unknown' cause", () => {
    expect(getCrashCauseTitle("unknown")).toBe("Daintree closed unexpectedly");
  });
});

describe("getCrashCauseDescription", () => {
  it("returns the description for a known cause", () => {
    const desc = getCrashCauseDescription("power-loss");
    expect(desc).toContain("rebooted");
  });

  it("falls back to the V1 generic description for undefined", () => {
    expect(getCrashCauseDescription(undefined)).toContain("unexpectedly");
  });
});

describe("getCrashCauseReportLabel", () => {
  it("returns the report label for a known cause", () => {
    expect(getCrashCauseReportLabel("external-kill")).toContain("External kill");
  });

  it("returns 'Unknown' for undefined (V1 log fallback)", () => {
    expect(getCrashCauseReportLabel(undefined)).toBe("Unknown");
  });
});
