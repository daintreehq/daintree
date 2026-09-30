import { describe, expect, it } from "vitest";
import {
  TerminalInOtherProjectError,
  formatNoPanelMessage,
  maskTerminalInOtherProject,
} from "../terminalInOtherProject.js";
import type { ActionDispatchResult } from "../../types/actions.js";

const details = { terminalId: "t1", projectId: "proj-b", viewResident: true };

describe("TerminalInOtherProjectError (#13120)", () => {
  it("names the terminal and owning project, and hints at a switch when the view is gone", () => {
    const resident = new TerminalInOtherProjectError("terminal.close", details);
    expect(resident.message).toContain('"t1"');
    expect(resident.message).toContain('"proj-b"');
    expect(resident.message).not.toContain("switch");

    const evicted = new TerminalInOtherProjectError("terminal.close", {
      ...details,
      viewResident: false,
    });
    expect(evicted.message).toContain("switch to it first");
  });

  it("yields plain details that survive a structured clone", () => {
    const err = new TerminalInOtherProjectError("terminal.close", details);
    expect(structuredClone(err.toDetails())).toEqual({ actionId: "terminal.close", ...details });
  });
});

describe("maskTerminalInOtherProject", () => {
  it("rewrites the code into the ordinary miss, identical to an unknown id's", () => {
    const err = new TerminalInOtherProjectError("terminal.close", details);
    const masked = maskTerminalInOtherProject({
      ok: false,
      error: { code: "TERMINAL_IN_OTHER_PROJECT", message: err.message, details: err.toDetails() },
    });

    expect(masked).toEqual({
      ok: false,
      error: {
        code: "EXECUTION_ERROR",
        message: formatNoPanelMessage("terminal.close", "t1"),
        details: expect.any(Error),
      },
    });
    expect(JSON.stringify(masked)).not.toContain("proj-b");
  });

  it.each<[string, ActionDispatchResult]>([
    ["a success", { ok: true, result: { closedIds: ["t1"] } }],
    ["another error", { ok: false, error: { code: "EXECUTION_ERROR", message: "boom" } }],
  ])("leaves %s untouched", (_label, result) => {
    expect(maskTerminalInOtherProject(result)).toBe(result);
  });

  it("passes a malformed renderer reply through rather than throwing", () => {
    expect(maskTerminalInOtherProject(undefined as never)).toBeUndefined();
    const noError = { ok: false } as never;
    expect(maskTerminalInOtherProject(noError)).toBe(noError);
  });
});
