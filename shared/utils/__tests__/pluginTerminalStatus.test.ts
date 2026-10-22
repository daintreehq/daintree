import { describe, expect, it } from "vitest";
import { sameTerminalStatus, validatePluginTerminalStatus } from "../pluginTerminalStatus.js";

function vet(terminalId: unknown, status: unknown) {
  return validatePluginTerminalStatus(terminalId, status, "acme.tracker", "acme.tracker");
}

describe("validatePluginTerminalStatus", () => {
  it("accepts a trimmed label and tooltip as a fresh copy", () => {
    const input = { label: " INV-0042 ", tooltip: " detail " };
    const result = vet("term-1", input);
    expect(result).toEqual({
      ok: true,
      terminalId: "term-1",
      status: { label: "INV-0042", tooltip: "detail" },
    });
    expect(result.ok && result.status).not.toBe(input);
  });

  it("treats null and undefined as a clear", () => {
    expect(vet("t", null)).toEqual({ ok: true, terminalId: "t", status: null });
    expect(vet("t", undefined)).toEqual({ ok: true, terminalId: "t", status: null });
  });

  it("rejects an empty or non-string terminal id", () => {
    for (const id of ["", 5, null, undefined]) {
      expect(vet(id, { label: "x" })).toEqual({
        ok: false,
        error: "terminalId must be a non-empty string",
      });
    }
  });

  it("shares the worktree status rules: single line, bounded, no extra fields", () => {
    expect(vet("t", { label: "a\nb" }).ok).toBe(false);
    expect(vet("t", { label: "x".repeat(33) }).ok).toBe(false);
    expect(vet("t", { label: "x", colour: "red" }).ok).toBe(false);
  });

  it("qualifies an own command into the instance namespace and refuses foreign ones", () => {
    expect(
      validatePluginTerminalStatus(
        "t",
        { label: "x", command: "acme.tracker.open" },
        "acme.tracker",
        "project__p__acme.tracker"
      )
    ).toEqual({
      ok: true,
      terminalId: "t",
      status: { label: "x", command: "project__p__acme.tracker.open" },
    });
    expect(vet("t", { label: "x", command: "other.plugin.open" }).ok).toBe(false);
    expect(vet("t", { label: "x", command: "terminal.close" }).ok).toBe(false);
  });
});

describe("sameTerminalStatus", () => {
  it("compares what the chip draws", () => {
    expect(sameTerminalStatus({ label: "a" }, { label: "a" })).toBe(true);
    expect(sameTerminalStatus({ label: "a" }, { label: "a", tooltip: "t" })).toBe(false);
    expect(sameTerminalStatus(undefined, { label: "a" })).toBe(false);
  });
});
