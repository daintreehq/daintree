import { describe, it, expect } from "vitest";
import type { PluginWorktreeLinked } from "../../types/plugin.js";
import { BUILTIN_GITHUB_PROVIDER_ID, BUILTIN_GITLAB_PROVIDER_ID } from "../forgeProviderIds.js";
import {
  issueNumberBelongsToLinkedPr,
  worktreeIssueLinkTarget,
} from "../worktreeIssueProjection.js";

function linkedPr(providerId: string, number: number): PluginWorktreeLinked {
  return {
    providerId,
    pr: {
      ref: { providerId, owner: "daintreehq", repo: "daintree", number, rawData: null },
      url: `https://example.test/pull/${number}`,
      state: "open",
    },
  };
}

describe("issueNumberBelongsToLinkedPr", () => {
  it("claims the number when a linked GitHub PR carries it (#12381)", () => {
    expect(issueNumberBelongsToLinkedPr(12189, linkedPr(BUILTIN_GITHUB_PROVIDER_ID, 12189))).toBe(
      true
    );
  });

  it("recognises the legacy bare github provider id", () => {
    expect(issueNumberBelongsToLinkedPr(12189, linkedPr("github", 12189))).toBe(true);
  });

  it("leaves a different number alone", () => {
    expect(issueNumberBelongsToLinkedPr(8851, linkedPr(BUILTIN_GITHUB_PROVIDER_ID, 12189))).toBe(
      false
    );
  });

  it("leaves the number alone without a linked PR", () => {
    expect(issueNumberBelongsToLinkedPr(12189, undefined)).toBe(false);
    expect(issueNumberBelongsToLinkedPr(12189, null)).toBe(false);
    expect(issueNumberBelongsToLinkedPr(12189, { providerId: BUILTIN_GITHUB_PROVIDER_ID })).toBe(
      false
    );
  });

  it("never claims an absent issue number", () => {
    expect(
      issueNumberBelongsToLinkedPr(undefined, linkedPr(BUILTIN_GITHUB_PROVIDER_ID, 12189))
    ).toBe(false);
  });

  it("defers to a linked issue even when the numbers match", () => {
    const linked: PluginWorktreeLinked = {
      ...linkedPr(BUILTIN_GITHUB_PROVIDER_ID, 12189),
      issue: {
        ref: {
          providerId: BUILTIN_GITHUB_PROVIDER_ID,
          owner: "daintreehq",
          repo: "daintree",
          number: 12189,
          rawData: null,
        },
        title: "Tracked elsewhere",
      },
    };
    expect(issueNumberBelongsToLinkedPr(12189, linked)).toBe(false);
  });

  it("keeps equal numbers apart on forges that number issues and merge requests separately", () => {
    expect(issueNumberBelongsToLinkedPr(12, linkedPr(BUILTIN_GITLAB_PROVIDER_ID, 12))).toBe(false);
    expect(issueNumberBelongsToLinkedPr(12, linkedPr("acme.gitlab", 12))).toBe(false);
  });

  it("keeps a tracker's claimed ENG-42 apart from the linked GitHub PR #42 (#13744)", () => {
    expect(
      issueNumberBelongsToLinkedPr(
        42,
        linkedPr(BUILTIN_GITHUB_PROVIDER_ID, 42),
        "acme.linear.linear"
      )
    ).toBe(false);
  });

  it("still drops a number GitHub itself owns", () => {
    expect(
      issueNumberBelongsToLinkedPr(
        42,
        linkedPr(BUILTIN_GITHUB_PROVIDER_ID, 42),
        BUILTIN_GITHUB_PROVIDER_ID
      )
    ).toBe(true);
  });
});

describe("worktreeIssueLinkTarget", () => {
  it("names the code forge for a number without provenance", () => {
    expect(worktreeIssueLinkTarget({})).toEqual({ role: "code" });
    expect(worktreeIssueLinkTarget({ issueKey: "ENG-1" })).toEqual({ role: "code" });
  });

  it("names the link's own provider with its id and key", () => {
    expect(
      worktreeIssueLinkTarget({
        issueProviderId: "acme.linear.linear",
        issueId: "uuid-1",
        issueKey: "ENG-42",
      })
    ).toEqual({ issueProviderId: "acme.linear.linear", issueId: "uuid-1", issueKey: "ENG-42" });
    expect(worktreeIssueLinkTarget({ issueProviderId: "acme.linear.linear" })).toEqual({
      issueProviderId: "acme.linear.linear",
    });
  });
});
