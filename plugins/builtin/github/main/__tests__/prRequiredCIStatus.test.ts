import { describe, expect, it } from "vitest";
import {
  deriveRequiredCIStatus,
  deriveGlobalCIStatus,
  normalizeRawState,
} from "../prRequiredCIStatus.js";

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

describe("normalizeRawState", () => {
  it("returns SUCCESS FAILURE ERROR PENDING EXPECTED as-is", () => {
    expect(normalizeRawState("SUCCESS")).toBe("SUCCESS");
    expect(normalizeRawState("FAILURE")).toBe("FAILURE");
    expect(normalizeRawState("ERROR")).toBe("ERROR");
    expect(normalizeRawState("PENDING")).toBe("PENDING");
    expect(normalizeRawState("EXPECTED")).toBe("EXPECTED");
  });

  it("uppercases lowercase valid states", () => {
    expect(normalizeRawState("success")).toBe("SUCCESS");
    expect(normalizeRawState("failure")).toBe("FAILURE");
    expect(normalizeRawState("pending")).toBe("PENDING");
  });

  it("returns undefined for null or undefined input", () => {
    expect(normalizeRawState(null)).toBeUndefined();
    expect(normalizeRawState(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeRawState("")).toBeUndefined();
  });

  it("returns undefined for unrecognized values", () => {
    expect(normalizeRawState("SKIPPED")).toBeUndefined();
    expect(normalizeRawState("STALE")).toBeUndefined();
    expect(normalizeRawState("IN_PROGRESS")).toBeUndefined();
  });
});

describe("deriveGlobalCIStatus", () => {
  it("returns undefined ciStatus when mergeStateStatus is UNKNOWN", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "UNKNOWN",
      checkRunCount: 5,
      checkRunCountsByState: [{ state: "SUCCESS", count: 5 }],
    });
    expect(r.ciStatus).toBeUndefined();
    expect(r.ciSummary).toBeUndefined();
  });

  it("returns FAILURE when mergeStateStatus is BLOCKED", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "BLOCKED",
      checkRunCount: 3,
      checkRunCountsByState: [{ state: "SUCCESS", count: 3 }],
    });
    expect(r.ciStatus).toBe("FAILURE");
    expect(r.ciSummary).toEqual({
      checkRunCount: 3,
      statusContextCount: 0,
      failingCount: 0,
      pendingCount: 0,
    });
  });

  it("returns FAILURE when check runs have failing conclusions", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "CLEAN",
      checkRunCount: 5,
      checkRunCountsByState: [
        { state: "SUCCESS", count: 3 },
        { state: "FAILURE", count: 2 },
      ],
    });
    expect(r.ciStatus).toBe("FAILURE");
    expect(r.ciSummary?.failingCount).toBe(2);
  });

  it("returns FAILURE when status contexts have ERROR/FAILURE states", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "CLEAN",
      statusContextCount: 4,
      statusContextCountsByState: [
        { state: "SUCCESS", count: 2 },
        { state: "ERROR", count: 2 },
      ],
    });
    expect(r.ciStatus).toBe("FAILURE");
    expect(r.ciSummary?.failingCount).toBe(2);
  });

  it("treats TIMED_OUT, ACTION_REQUIRED, CANCELLED, STARTUP_FAILURE, STALE as failing", () => {
    for (const state of ["TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "STARTUP_FAILURE", "STALE"]) {
      const r = deriveGlobalCIStatus({
        mergeStateStatus: "CLEAN",
        checkRunCount: 1,
        checkRunCountsByState: [{ state, count: 1 }],
      });
      expect(r.ciStatus).toBe("FAILURE");
      expect(r.ciSummary?.failingCount).toBe(1);
    }
  });

  it("returns PENDING when only pending check runs exist", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "CLEAN",
      checkRunCount: 2,
      checkRunCountsByState: [
        { state: "SUCCESS", count: 1 },
        { state: "IN_PROGRESS", count: 1 },
      ],
    });
    expect(r.ciStatus).toBe("PENDING");
    expect(r.ciSummary).toEqual({
      checkRunCount: 2,
      statusContextCount: 0,
      failingCount: 0,
      pendingCount: 1,
    });
  });

  it("returns PENDING when only pending status contexts exist", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "CLEAN",
      statusContextCount: 3,
      statusContextCountsByState: [
        { state: "PENDING", count: 2 },
        { state: "SUCCESS", count: 1 },
      ],
    });
    expect(r.ciStatus).toBe("PENDING");
    expect(r.ciSummary?.pendingCount).toBe(2);
  });

  it("returns SUCCESS when all checks are successful", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "CLEAN",
      checkRunCount: 3,
      statusContextCount: 2,
      checkRunCountsByState: [{ state: "SUCCESS", count: 3 }],
      statusContextCountsByState: [{ state: "SUCCESS", count: 2 }],
    });
    expect(r.ciStatus).toBe("SUCCESS");
    expect(r.ciSummary).toEqual({
      checkRunCount: 3,
      statusContextCount: 2,
      failingCount: 0,
      pendingCount: 0,
    });
  });

  it("returns undefined ciStatus when there are no checks at all", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "CLEAN",
      checkRunCount: 0,
      statusContextCount: 0,
    });
    expect(r.ciStatus).toBeUndefined();
  });

  it("prioritises FAILURE over PENDING when both are present", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "CLEAN",
      checkRunCount: 3,
      checkRunCountsByState: [
        { state: "FAILURE", count: 1 },
        { state: "IN_PROGRESS", count: 2 },
      ],
    });
    expect(r.ciStatus).toBe("FAILURE");
  });

  it("handles null/undefined buckets gracefully", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "CLEAN",
      checkRunCount: 1,
      checkRunCountsByState: null,
      statusContextCountsByState: undefined,
      statusContextCount: 1,
    });
    expect(r.ciStatus).toBeUndefined();
  });

  it("treats unknown bucket state strings conservatively (not SUCCESS)", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "CLEAN",
      checkRunCount: 2,
      checkRunCountsByState: [{ state: "SOME_FUTURE_STATE", count: 2 }],
    });
    // Unknown states prevent SUCCESS — treat as unclassifiable
    expect(r.ciStatus).toBeUndefined();
    expect(r.ciSummary).toBeUndefined();
  });

  it("handles missing mergeStateStatus (treat as non-UNKNOWN/non-BLOCKED)", () => {
    const r = deriveGlobalCIStatus({
      checkRunCount: 1,
      checkRunCountsByState: [{ state: "SUCCESS", count: 1 }],
    });
    expect(r.ciStatus).toBe("SUCCESS");
  });

  it("defaults null counts to 0 and returns no summary when total is zero", () => {
    const r = deriveGlobalCIStatus({
      mergeStateStatus: "CLEAN",
      checkRunCount: null,
      statusContextCount: null,
    });
    expect(r.ciStatus).toBeUndefined();
    expect(r.ciSummary).toBeUndefined();
  });
});
