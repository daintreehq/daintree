import { describe, expect, it } from "vitest";

import {
  ConfirmationStagedError,
  confirmationStagedMessage,
  isStagedConfirmation,
} from "../confirmationStaged";

// The predicate five generic dispatchers rely on to tell "a dialog just opened"
// from "this really failed" (#12120). Matching the code alone would swallow the
// outer gate's genuine refusal, which those surfaces must still report.
describe("isStagedConfirmation", () => {
  it("matches a staged confirmation carrying the sentinel", () => {
    expect(
      isStagedConfirmation({
        code: "CONFIRMATION_REQUIRED",
        details: new ConfirmationStagedError(confirmationStagedMessage("Killing this terminal")),
      })
    ).toBe(true);
  });

  it("rejects the outer gate's refusal, which uses the same code without the sentinel", () => {
    expect(
      isStagedConfirmation({
        code: "CONFIRMATION_REQUIRED",
        details: new Error("requires explicit confirmation from agent sources"),
      })
    ).toBe(false);
  });

  it("rejects the same code with no details at all", () => {
    expect(isStagedConfirmation({ code: "CONFIRMATION_REQUIRED" })).toBe(false);
  });

  // The sentinel is only meaningful together with the code ActionService maps
  // it to; a different code means something else produced this failure.
  it("rejects another code even when the sentinel is attached", () => {
    expect(
      isStagedConfirmation({
        code: "EXECUTION_ERROR",
        details: new ConfirmationStagedError("staged"),
      })
    ).toBe(false);
  });
});

describe("confirmationStagedMessage", () => {
  it("leads with what did not happen, so a model cannot read it as done", () => {
    const message = confirmationStagedMessage("Killing this terminal");
    expect(message).toContain("Killing this terminal was not performed");
    expect(message).toContain("Nothing changed.");
  });
});
