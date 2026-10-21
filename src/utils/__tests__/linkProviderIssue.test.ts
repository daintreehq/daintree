import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@shared/types/forge";

const startAttachIssue = vi.hoisted(() => vi.fn());
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ startAttachIssue }) }),
}));

import { issueAttachPayload, linkProviderIssue } from "../linkProviderIssue";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 42,
    title: "Fix login",
    body: "",
    state: "open",
    rawState: "open",
    url: "",
    assignees: [],
    labels: [],
    createdAt: 0,
    updatedAt: 0,
    rawData: null,
    ...overrides,
  };
}

describe("issue provenance links (#13700)", () => {
  beforeEach(() => startAttachIssue.mockClear());

  it("keeps the legacy attach shape for an unstamped issue, even one with an id and key", () => {
    expect(issueAttachPayload("wt", issue({ id: "x", key: "GH-42" }))).toEqual({
      worktreeId: "wt",
      issueNumber: 42,
      issueTitle: "Fix login",
    });
  });

  it("carries the provider, stable id and key for an issue an issues provider served", () => {
    expect(
      issueAttachPayload(
        "wt",
        issue({ providerId: "acme.tracker.tracker", id: "uuid-42", key: "ENG-42" })
      )
    ).toEqual({
      worktreeId: "wt",
      issueNumber: 42,
      issueTitle: "Fix login",
      issueProviderId: "acme.tracker.tracker",
      issueId: "uuid-42",
      issueKey: "ENG-42",
    });
  });

  it("links a new worktree only to a stamped issue", () => {
    linkProviderIssue("wt", issue());
    linkProviderIssue("wt", null);
    expect(startAttachIssue).not.toHaveBeenCalled();

    linkProviderIssue("wt", issue({ providerId: "acme.tracker.tracker" }));
    expect(startAttachIssue).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "wt", issueProviderId: "acme.tracker.tracker" })
    );
  });
});
