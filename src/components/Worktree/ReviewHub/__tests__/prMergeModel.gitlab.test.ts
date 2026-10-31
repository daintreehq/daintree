import { describe, expect, it } from "vitest";
import type { ForgeRepoMetadataPayload } from "@shared/types/ipc/forge";
import {
  graphqlMergeRequestToForgePR,
  mergeRequestToForgePR,
} from "../../../../../plugins/builtin/gitlab/main/mappers";
import type { GitLabMergeRequest } from "../../../../../plugins/builtin/gitlab/shared/types";
import { derivePrMergeControl } from "../prMergeModel";

const HOST = "gitlab.com";

function restMR(overrides: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest {
  return {
    id: 1000,
    iid: 42,
    title: "Add feature",
    description: "",
    state: "opened",
    draft: false,
    web_url: "https://gitlab.com/group/project/-/merge_requests/42",
    source_branch: "feature/thing",
    target_branch: "main",
    detailed_merge_status: "mergeable",
    has_conflicts: false,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-02T10:00:00Z",
    closed_at: null,
    merged_at: null,
    ...overrides,
  };
}

function graphqlMR(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: "42",
    title: "Add feature",
    description: "",
    state: "opened",
    draft: false,
    webUrl: "https://gitlab.com/group/project/-/merge_requests/42",
    sourceBranch: "feature/thing",
    targetBranch: "main",
    detailedMergeStatus: "MERGEABLE",
    createdAt: "2026-07-01T10:00:00Z",
    updatedAt: "2026-07-02T10:00:00Z",
    ...overrides,
  };
}

// What the GitLab provider's repository read carries through the host today.
const GITLAB_METADATA: ForgeRepoMetadataPayload = {
  defaultBranch: "main",
  isPrivate: true,
  isFork: false,
  isArchived: false,
  description: null,
  license: null,
  autoMergeSupported: false,
  rawData: {},
};

describe("derivePrMergeControl for a GitLab merge request", () => {
  it("never lands an open, mergeable REST MR on the unreported retry state", () => {
    const model = derivePrMergeControl(mergeRequestToForgePR(restMR(), HOST), GITLAB_METADATA);
    expect(model).toMatchObject({ kind: "unavailable", reason: "unsupported" });
  });

  it("never lands an MR from the GraphQL branch lookup on the unreported retry state", () => {
    const model = derivePrMergeControl(
      graphqlMergeRequestToForgePR(graphqlMR(), HOST),
      GITLAB_METADATA
    );
    expect(model).toMatchObject({ kind: "unavailable", reason: "unsupported" });
  });
});
