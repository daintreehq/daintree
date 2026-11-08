import { describe, expect, it } from "vitest";
import { validateBranchName } from "../../../../../shared/utils/pathPattern.js";
import { issueNumberOf, mapIssue, normalizeIssueState, suggestBranchName } from "../mappers.js";

const SITE = "https://acme.atlassian.net";

describe("normalizeIssueState", () => {
  it("reads only the done category as closed", () => {
    expect(normalizeIssueState("done")).toBe("closed");
    expect(normalizeIssueState("new")).toBe("open");
    expect(normalizeIssueState("indeterminate")).toBe("open");
    expect(normalizeIssueState("undefined")).toBe("open");
    expect(normalizeIssueState(null)).toBe("open");
  });
});

describe("issueNumberOf", () => {
  it("takes the number out of the key", () => {
    expect(issueNumberOf("ENG-12")).toBe(12);
    expect(issueNumberOf("A_B2-7")).toBe(7);
  });
});

describe("suggestBranchName", () => {
  it("leads with the key in its own case", () => {
    expect(suggestBranchName("ENG-12", "Fix the login page!")).toBe("ENG-12-fix-the-login-page");
  });

  it("folds accents rather than dropping the letters", () => {
    expect(suggestBranchName("ENG-12", "Café crème")).toBe("ENG-12-cafe-creme");
  });

  it("is the key alone when the summary leaves nothing", () => {
    expect(suggestBranchName("ENG-12", "日本語")).toBe("ENG-12");
    expect(suggestBranchName("ENG-12", "")).toBe("ENG-12");
  });

  it("cuts a long summary at a word", () => {
    const name = suggestBranchName(
      "ENG-12",
      "Make the extremely long summary line stop somewhere sensible please"
    );
    expect(name).toBe("ENG-12-make-the-extremely-long-summary-line-stop");
  });

  it.each(["Fix: the [login] ~page^ .lock", "a..b", "@{x}", "..", "trailing."])(
    "always gives git a valid name for %s",
    (summary) => {
      expect(validateBranchName(suggestBranchName("ENG-12", summary)).valid).toBe(true);
    }
  );
});

describe("mapIssue", () => {
  const node = {
    id: "10042",
    key: "ENG-12",
    fields: {
      summary: "Fix the login",
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "It breaks." }] }],
      },
      status: { name: "In Review", statusCategory: { key: "indeterminate" } },
      assignee: {
        accountId: "abc",
        displayName: "Ada",
        avatarUrls: { "48x48": "https://example.com/ada.png" },
      },
      reporter: { accountId: "def", displayName: "Grace" },
      labels: ["bug", "login"],
      created: "2026-10-01T10:00:00.000+0000",
      updated: "2026-10-02T10:00:00.000+0000",
      resolutiondate: null,
    },
  };

  it("maps the key to the number, id and url the issue flows use", () => {
    const issue = mapIssue(node, SITE);
    expect(issue.number).toBe(12);
    expect(issue.key).toBe("ENG-12");
    expect(issue.id).toBe("10042");
    expect(issue.url).toBe("https://acme.atlassian.net/browse/ENG-12");
    expect(issue.branchName).toBe("ENG-12-fix-the-login");
  });

  it("reads the description as text", () => {
    expect(mapIssue(node, SITE).body).toBe("It breaks.");
  });

  it("maps people, labels and Jira's date format", () => {
    const issue = mapIssue(node, SITE);
    expect(issue.assignees).toEqual([
      { login: "Ada", avatarUrl: "https://example.com/ada.png", rawData: { accountId: "abc" } },
    ]);
    expect(issue.author?.login).toBe("Grace");
    expect(issue.labels).toEqual([{ name: "bug" }, { name: "login" }]);
    expect(issue.createdAt).toBe(Date.UTC(2026, 9, 1, 10));
    expect(issue.updatedAt).toBe(Date.UTC(2026, 9, 2, 10));
    expect(issue.state).toBe("open");
    expect(issue.rawState).toBe("In Review");
    expect(issue.closedAt).toBeNull();
  });

  it("dates a closed issue by its resolution", () => {
    const issue = mapIssue(
      {
        ...node,
        fields: {
          ...node.fields,
          status: { name: "Done", statusCategory: { key: "done" } },
          resolutiondate: "2026-10-03T10:00:00.000+0000",
        },
      },
      SITE
    );
    expect(issue.state).toBe("closed");
    expect(issue.closedAt).toBe(Date.UTC(2026, 9, 3, 10));
  });

  it("keeps the document tree out of rawData", () => {
    expect(mapIssue(node, SITE).rawData).toEqual({ id: "10042", key: "ENG-12" });
  });

  it("copes with an issue carrying no fields", () => {
    const issue = mapIssue({ id: "1", key: "ENG-1" }, SITE);
    expect(issue).toMatchObject({
      number: 1,
      title: "",
      body: "",
      state: "open",
      assignees: [],
      labels: [],
      createdAt: 0,
      updatedAt: 0,
      branchName: "ENG-1",
    });
    expect(issue.author).toBeUndefined();
  });
});
