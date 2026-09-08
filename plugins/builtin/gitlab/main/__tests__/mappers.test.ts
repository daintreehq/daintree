import { describe, expect, it } from "vitest";
import {
  absolutizeAvatarUrl,
  gitlabIssueToForgeIssue,
  gitlabLabelsToForgeLabels,
  gitlabReleaseToForgeRelease,
  graphqlMergeRequestToForgePR,
  isDraftMergeRequest,
  mergeRequestToForgePR,
  normalizeGitLabMRState,
  pipelineStatusToCIState,
  stripDraftPrefix,
} from "../mappers.js";
import { getInstanceUrl, resetAuthStateForTests, setInstanceUrlReader } from "../GitLabAuth.js";
import type { GitLabMergeRequest } from "../../shared/types.js";

const HOST = "gitlab.com";

function baseMR(overrides: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest {
  return {
    id: 1000,
    iid: 42,
    title: "Add feature",
    description: "Body text",
    state: "opened",
    draft: false,
    web_url: "https://gitlab.com/group/project/-/merge_requests/42",
    author: { id: 7, username: "dev", avatar_url: "https://gitlab.com/avatar.png" },
    source_branch: "feature/thing",
    target_branch: "main",
    user_notes_count: 3,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-02T10:00:00Z",
    closed_at: null,
    merged_at: null,
    ...overrides,
  };
}

describe("MR state normalization", () => {
  it("maps the four GitLab states", () => {
    expect(normalizeGitLabMRState("opened")).toBe("open");
    expect(normalizeGitLabMRState("merged")).toBe("merged");
    expect(normalizeGitLabMRState("closed")).toBe("closed");
    expect(normalizeGitLabMRState("locked")).toBe("open");
  });
});

describe("draft detection", () => {
  it("honors the boolean draft field", () => {
    expect(isDraftMergeRequest({ draft: true, title: "Anything" })).toBe(true);
  });

  it("honors the legacy work_in_progress field", () => {
    expect(isDraftMergeRequest({ work_in_progress: true, title: "Anything" })).toBe(true);
  });

  // The booleans are derived server-side from the title, so a present `false`
  // is the server disagreeing with what the title looks like — and it wins.
  it("lets an explicit false override a draft-looking title", () => {
    expect(isDraftMergeRequest({ draft: false, title: "Draft: thing" })).toBe(false);
    expect(isDraftMergeRequest({ work_in_progress: false, title: "[Draft] thing" })).toBe(false);
  });

  it("falls back to title conventions only when neither boolean is present", () => {
    expect(isDraftMergeRequest({ title: "Draft: thing" })).toBe(true);
    expect(isDraftMergeRequest({ title: "[Draft] thing" })).toBe(true);
    expect(isDraftMergeRequest({ title: "(Draft) thing" })).toBe(true);
    expect(isDraftMergeRequest({ title: "Draft - thing" })).toBe(true);
    expect(isDraftMergeRequest({ title: "draft: lowercase" })).toBe(true);
    expect(isDraftMergeRequest({ title: "Drafting a doc" })).toBe(false);
  });

  // GitLab removed WIP: in 14.8, so a WIP-titled MR is an ordinary open one.
  // Calling it a draft would make "convert to draft" a silent no-op.
  it("does not treat the removed WIP prefix as a draft", () => {
    expect(isDraftMergeRequest({ title: "WIP: thing" })).toBe(false);
    expect(isDraftMergeRequest({ title: "[WIP] thing" })).toBe(false);
    expect(stripDraftPrefix("WIP: thing")).toBe("WIP: thing");
  });

  it("strips stacked draft prefixes", () => {
    expect(stripDraftPrefix("Draft: [Draft] thing")).toBe("thing");
    expect(stripDraftPrefix("[Draft] thing")).toBe("thing");
    expect(stripDraftPrefix("(Draft) thing")).toBe("thing");
    expect(stripDraftPrefix("Draft - thing")).toBe("thing");
    expect(stripDraftPrefix("thing")).toBe("thing");
  });
});

describe("mergeableFromMR via mergeRequestToForgePR", () => {
  const mr = (detailed_merge_status: string): GitLabMergeRequest => ({
    iid: 1,
    state: "opened",
    detailed_merge_status,
  });

  it("reports the computing states as not-yet-known, not as blocked", () => {
    // A merge button disabled for a reason GitLab hasn't established yet is
    // worse than one that says "checking".
    for (const status of ["checking", "unchecked", "preparing", "approvals_syncing"]) {
      expect(mergeRequestToForgePR(mr(status), HOST).mergeable).toBeNull();
    }
  });

  it("separates mergeable from the blocked states", () => {
    expect(mergeRequestToForgePR(mr("mergeable"), HOST).mergeable).toBe(true);
    for (const status of ["conflict", "ci_must_pass", "draft_status", "not_approved"]) {
      expect(mergeRequestToForgePR(mr(status), HOST).mergeable).toBe(false);
    }
  });
});

describe("pipelineStatusToCIState", () => {
  it("maps terminal and in-flight statuses", () => {
    expect(pipelineStatusToCIState("success")).toBe("success");
    expect(pipelineStatusToCIState("failed")).toBe("failure");
    expect(pipelineStatusToCIState("running")).toBe("pending");
    expect(pipelineStatusToCIState("created")).toBe("pending");
    expect(pipelineStatusToCIState("canceled")).toBe("neutral");
    expect(pipelineStatusToCIState("skipped")).toBe("neutral");
    expect(pipelineStatusToCIState("manual")).toBe("neutral");
    expect(pipelineStatusToCIState("something-new")).toBe("unknown");
    expect(pipelineStatusToCIState(undefined)).toBeUndefined();
  });
});

describe("mergeRequestToForgePR", () => {
  it("numbers by iid, not the global id", () => {
    const pr = mergeRequestToForgePR(baseMR(), HOST);
    expect(pr.number).toBe(42);
  });

  it("maps branches, comment count, and timestamps", () => {
    const pr = mergeRequestToForgePR(baseMR(), HOST);
    expect(pr.headRef).toBe("feature/thing");
    expect(pr.baseRef).toBe("main");
    expect(pr.commentCount).toBe(3);
    expect(pr.createdAt).toBe(Date.parse("2026-07-01T10:00:00Z"));
    expect(pr.state).toBe("open");
    expect(pr.merged).toBe(false);
  });

  it("treats merged_at as authoritative for merged state", () => {
    const pr = mergeRequestToForgePR(
      baseMR({ state: "merged", merged_at: "2026-07-03T10:00:00Z" }),
      HOST
    );
    expect(pr.state).toBe("merged");
    expect(pr.merged).toBe(true);
    expect(pr.mergedAt).toBe(Date.parse("2026-07-03T10:00:00Z"));
  });

  it("derives mergeable from detailed_merge_status", () => {
    expect(
      mergeRequestToForgePR(baseMR({ detailed_merge_status: "mergeable" }), HOST).mergeable
    ).toBe(true);
    expect(
      mergeRequestToForgePR(baseMR({ detailed_merge_status: "conflicts" }), HOST).mergeable
    ).toBe(false);
    expect(
      mergeRequestToForgePR(baseMR({ detailed_merge_status: "checking" }), HOST).mergeable
    ).toBeNull();
    expect(
      mergeRequestToForgePR(baseMR({ detailed_merge_status: "preparing" }), HOST).mergeable
    ).toBeNull();
    expect(mergeRequestToForgePR(baseMR(), HOST).mergeable).toBeNull();
  });

  it("maps the head pipeline into ciStatus", () => {
    const pr = mergeRequestToForgePR(baseMR({ head_pipeline: { status: "failed" } }), HOST);
    expect(pr.ciStatus).toBe("failure");
  });

  it("preserves the verbatim state as rawState", () => {
    const pr = mergeRequestToForgePR(baseMR({ state: "locked" }), HOST);
    expect(pr.rawState).toBe("locked");
    expect(pr.state).toBe("open");
  });
});

describe("gitlabIssueToForgeIssue", () => {
  it("maps iid, labels, assignees, and state", () => {
    const issue = gitlabIssueToForgeIssue(
      {
        id: 900,
        iid: 7,
        title: "Bug",
        description: "It breaks",
        state: "opened",
        web_url: "https://gitlab.com/group/project/-/issues/7",
        author: { id: 1, username: "reporter" },
        assignees: [{ id: 2, username: "fixer", avatar_url: "/uploads/a.png" }],
        labels: ["bug", "p1"],
        user_notes_count: 5,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-02T00:00:00Z",
        closed_at: null,
      },
      "gitlab.example.com"
    );
    expect(issue.number).toBe(7);
    expect(issue.state).toBe("open");
    expect(issue.labels).toEqual([{ name: "bug" }, { name: "p1" }]);
    expect(issue.assignees[0].login).toBe("fixer");
    expect(issue.assignees[0].avatarUrl).toBe("https://gitlab.example.com/uploads/a.png");
    expect(issue.commentCount).toBe(5);
  });
});

describe("absolutizeAvatarUrl", () => {
  it("passes absolute URLs through and prefixes host-relative ones", () => {
    expect(absolutizeAvatarUrl("https://cdn.example/a.png", HOST)).toBe(
      "https://cdn.example/a.png"
    );
    // Not the configured instance, so plain https on the default port.
    expect(absolutizeAvatarUrl("/uploads/a.png", "gitlab.example.com")).toBe(
      "https://gitlab.example.com/uploads/a.png"
    );
    expect(absolutizeAvatarUrl(undefined, HOST)).toBeUndefined();
    expect(absolutizeAvatarUrl("", HOST)).toBeUndefined();
  });

  it("resolves against the configured origin for a self-hosted instance", async () => {
    setInstanceUrlReader(() => Promise.resolve("http://code.example:8443/gitlab"));
    await getInstanceUrl();
    try {
      // The scheme and port come from the instance, not a hardcoded https.
      expect(absolutizeAvatarUrl("/uploads/a.png", "code.example")).toBe(
        "http://code.example:8443/uploads/a.png"
      );
    } finally {
      setInstanceUrlReader(null);
      resetAuthStateForTests();
    }
  });
});

describe("gitlabLabelsToForgeLabels", () => {
  it("keeps only string names", () => {
    expect(gitlabLabelsToForgeLabels(["bug", 3, null, "ux"])).toEqual([
      { name: "bug" },
      { name: "ux" },
    ]);
    expect(gitlabLabelsToForgeLabels(undefined)).toEqual([]);
  });
});

describe("gitlabReleaseToForgeRelease", () => {
  const repo = { host: "gitlab.com", owner: "group", repo: "project" };

  it("maps tag, body, and published date", () => {
    const release = gitlabReleaseToForgeRelease(
      {
        tag_name: "v1.2.0",
        name: "v1.2.0",
        description: "Notes",
        released_at: "2026-06-01T00:00:00Z",
        created_at: "2026-05-31T00:00:00Z",
        _links: { self: "https://gitlab.com/group/project/-/releases/v1.2.0" },
      },
      repo
    );
    expect(release.tagName).toBe("v1.2.0");
    expect(release.publishedAt).toBe(Date.parse("2026-06-01T00:00:00Z"));
    expect(release.isDraft).toBe(false);
    expect(release.url).toBe("https://gitlab.com/group/project/-/releases/v1.2.0");
  });

  it("builds the release URL when _links is missing", () => {
    const release = gitlabReleaseToForgeRelease({ tag_name: "v1.0.0" }, repo);
    expect(release.url).toBe("https://gitlab.com/group/project/-/releases/v1.0.0");
  });
});

describe("graphqlMergeRequestToForgePR", () => {
  it("parses the string iid and camelCase fields", () => {
    const pr = graphqlMergeRequestToForgePR(
      {
        iid: "42",
        title: "Draft: thing",
        description: "Body",
        state: "opened",
        draft: true,
        sourceBranch: "feature/x",
        targetBranch: "main",
        webUrl: "https://gitlab.com/g/p/-/merge_requests/42",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
        author: { username: "dev", avatarUrl: "/uploads/a.png" },
        headPipeline: { status: "SUCCESS" },
      },
      "gitlab.com"
    );
    expect(pr).not.toBeNull();
    expect(pr?.number).toBe(42);
    expect(pr?.isDraft).toBe(true);
    expect(pr?.headRef).toBe("feature/x");
    expect(pr?.ciStatus).toBe("success");
    expect(pr?.author?.avatarUrl).toBe("https://gitlab.com/uploads/a.png");
  });

  it("returns null for nodes without a usable iid", () => {
    expect(graphqlMergeRequestToForgePR({ iid: "not-a-number" }, HOST)).toBeNull();
    expect(graphqlMergeRequestToForgePR({}, HOST)).toBeNull();
  });

  // Same precedence as the REST mapper: the server's boolean is derived from
  // the title, so a present `false` is authoritative and the title loses.
  it("lets an explicit draft:false override a draft-looking title", () => {
    const node = { iid: "3", title: "Draft: thing", draft: false };
    expect(graphqlMergeRequestToForgePR(node, HOST)?.isDraft).toBe(false);
  });

  it("falls back to the title when the node carries no draft field", () => {
    expect(graphqlMergeRequestToForgePR({ iid: "3", title: "Draft: thing" }, HOST)?.isDraft).toBe(
      true
    );
    expect(graphqlMergeRequestToForgePR({ iid: "3", title: "WIP: thing" }, HOST)?.isDraft).toBe(
      false
    );
  });
});
