import { describe, expect, it } from "vitest";
import { mapIssue, normalizeIssueState } from "../mappers.js";

describe("normalizeIssueState", () => {
  it.each([
    ["triage", "open"],
    ["backlog", "open"],
    ["unstarted", "open"],
    ["started", "open"],
    ["completed", "closed"],
    ["canceled", "closed"],
    ["duplicate", "closed"],
    // A state type Linear adds later stays pickable rather than vanishing.
    ["someNewType", "open"],
    [null, "open"],
  ])("maps %j to %s", (type, expected) => {
    expect(normalizeIssueState(type)).toBe(expected);
  });
});

describe("mapIssue", () => {
  const base = {
    id: "uuid",
    identifier: "ENG-7",
    number: 7,
    title: "Title",
    url: "https://linear.app/acme/issue/ENG-7/title",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  };

  it("stamps closedAt from the completion time of a finished issue", () => {
    const issue = mapIssue({
      ...base,
      state: { name: "Done", type: "completed" },
      completedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(issue.state).toBe("closed");
    expect(issue.closedAt).toBe(Date.parse("2026-10-02T00:00:00.000Z"));
  });

  it("leaves closedAt null while open, and an absent body empty", () => {
    const issue = mapIssue({ ...base, state: { name: "Todo", type: "unstarted" } });
    expect(issue.closedAt).toBeNull();
    expect(issue.body).toBe("");
    expect(issue.assignees).toEqual([]);
    expect(issue.branchName).toBeUndefined();
  });
});
