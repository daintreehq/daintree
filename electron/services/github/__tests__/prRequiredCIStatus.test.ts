import { describe, expect, it } from "vitest";
import { deriveRequiredCIStatus } from "../prRequiredCIStatus.js";

describe("deriveRequiredCIStatus", () => {
  it("returns raw status and no summary when contexts is null", () => {
    const r = deriveRequiredCIStatus(null, false, "FAILURE");
    expect(r.ciStatus).toBe("FAILURE");
    expect(r.ciSummary).toBeUndefined();
  });

  it("returns raw status and no summary when page is truncated", () => {
    const r = deriveRequiredCIStatus(
      [
        {
          __typename: "CheckRun",
          conclusion: "SUCCESS",
          status: "COMPLETED",
          isRequired: true,
        },
      ],
      true,
      "FAILURE"
    );
    expect(r.ciStatus).toBe("FAILURE");
    expect(r.ciSummary).toBeUndefined();
  });

  it("downgrades FAILURE rollup to SUCCESS when only non-required checks fail", () => {
    const r = deriveRequiredCIStatus(
      [
        {
          __typename: "CheckRun",
          conclusion: "SUCCESS",
          status: "COMPLETED",
          isRequired: true,
        },
        {
          __typename: "CheckRun",
          conclusion: "FAILURE",
          status: "COMPLETED",
          isRequired: false,
        },
      ],
      false,
      "FAILURE"
    );
    expect(r.ciStatus).toBe("SUCCESS");
    expect(r.ciSummary).toEqual({ requiredTotal: 1, requiredFailing: 0, requiredPending: 0 });
  });

  it("keeps FAILURE when a required CheckRun has a failing conclusion", () => {
    const r = deriveRequiredCIStatus(
      [
        {
          __typename: "CheckRun",
          conclusion: "FAILURE",
          status: "COMPLETED",
          isRequired: true,
        },
        {
          __typename: "CheckRun",
          conclusion: "SUCCESS",
          status: "COMPLETED",
          isRequired: true,
        },
      ],
      false,
      "FAILURE"
    );
    expect(r.ciStatus).toBe("FAILURE");
    expect(r.ciSummary).toEqual({ requiredTotal: 2, requiredFailing: 1, requiredPending: 0 });
  });

  it("treats TIMED_OUT, ACTION_REQUIRED, CANCELLED, STARTUP_FAILURE as failing", () => {
    for (const conclusion of [
      "TIMED_OUT",
      "ACTION_REQUIRED",
      "CANCELLED",
      "STARTUP_FAILURE",
      "STALE",
    ]) {
      const r = deriveRequiredCIStatus(
        [{ __typename: "CheckRun", conclusion, status: "COMPLETED", isRequired: true }],
        false,
        "FAILURE"
      );
      expect(r.ciStatus).toBe("FAILURE");
      expect(r.ciSummary?.requiredFailing).toBe(1);
    }
  });

  it("treats StatusContext ERROR/FAILURE states as failing", () => {
    for (const state of ["ERROR", "FAILURE"]) {
      const r = deriveRequiredCIStatus(
        [{ __typename: "StatusContext", state, isRequired: true }],
        false,
        "ERROR"
      );
      expect(r.ciStatus).toBe("FAILURE");
      expect(r.ciSummary?.requiredFailing).toBe(1);
    }
  });

  it("reports PENDING when a required CheckRun is still in progress and nothing is failing", () => {
    const r = deriveRequiredCIStatus(
      [
        {
          __typename: "CheckRun",
          conclusion: null,
          status: "IN_PROGRESS",
          isRequired: true,
        },
        {
          __typename: "CheckRun",
          conclusion: "SUCCESS",
          status: "COMPLETED",
          isRequired: true,
        },
      ],
      false,
      "PENDING"
    );
    expect(r.ciStatus).toBe("PENDING");
    expect(r.ciSummary).toEqual({ requiredTotal: 2, requiredFailing: 0, requiredPending: 1 });
  });

  it("falls back to raw rollup when contexts list is empty", () => {
    const r = deriveRequiredCIStatus([], false, "PENDING");
    expect(r.ciStatus).toBe("PENDING");
    expect(r.ciSummary).toBeUndefined();
  });

  it("falls back to raw FAILURE rollup when no required checks exist", () => {
    const r = deriveRequiredCIStatus(
      [
        {
          __typename: "CheckRun",
          conclusion: "FAILURE",
          status: "COMPLETED",
          isRequired: false,
        },
      ],
      false,
      "FAILURE"
    );
    expect(r.ciStatus).toBe("FAILURE");
    expect(r.ciSummary).toBeUndefined();
  });

  it("falls back to raw PENDING rollup when no required checks exist", () => {
    const r = deriveRequiredCIStatus(
      [
        {
          __typename: "CheckRun",
          conclusion: null,
          status: "IN_PROGRESS",
          isRequired: false,
        },
      ],
      false,
      "PENDING"
    );
    expect(r.ciStatus).toBe("PENDING");
    expect(r.ciSummary).toBeUndefined();
  });

  it("falls back to raw SUCCESS rollup when no required checks exist", () => {
    const r = deriveRequiredCIStatus(
      [
        {
          __typename: "CheckRun",
          conclusion: "SUCCESS",
          status: "COMPLETED",
          isRequired: false,
        },
      ],
      false,
      "SUCCESS"
    );
    expect(r.ciStatus).toBe("SUCCESS");
    expect(r.ciSummary).toBeUndefined();
  });

  it("ignores non-required checks entirely", () => {
    const r = deriveRequiredCIStatus(
      [
        { __typename: "CheckRun", conclusion: "SUCCESS", status: "COMPLETED", isRequired: true },
        { __typename: "CheckRun", conclusion: "FAILURE", status: "COMPLETED", isRequired: false },
        { __typename: "StatusContext", state: "ERROR", isRequired: false },
      ],
      false,
      "FAILURE"
    );
    expect(r.ciStatus).toBe("SUCCESS");
    expect(r.ciSummary).toEqual({ requiredTotal: 1, requiredFailing: 0, requiredPending: 0 });
  });

  it("prioritises FAILURE over PENDING when both are present", () => {
    const r = deriveRequiredCIStatus(
      [
        { __typename: "CheckRun", conclusion: "FAILURE", status: "COMPLETED", isRequired: true },
        { __typename: "CheckRun", conclusion: null, status: "IN_PROGRESS", isRequired: true },
      ],
      false,
      "PENDING"
    );
    expect(r.ciStatus).toBe("FAILURE");
    expect(r.ciSummary).toEqual({ requiredTotal: 2, requiredFailing: 1, requiredPending: 1 });
  });
});
