import { describe, expect, it } from "vitest";
import type { PR } from "@shared/types/forge";
import type { ForgeRepoMetadataPayload } from "@shared/types/ipc/forge";
import {
  AUTO_MERGE_OFF_REASON,
  CANNOT_CANCEL_REASON,
  MERGE_SETTINGS_UNREAD_REASON,
  MERGE_STATUS_UNREPORTED_REASON,
  applyMergeOutcome,
  confirmBlockReason,
  derivePrMergeControl,
  describeMergeRejection,
  effectiveMergeMode,
  isMergeOutcomeReflected,
  mergeActionLabel,
} from "../prMergeModel";

function pr(overrides: Partial<PR> = {}): PR {
  return {
    number: 1,
    title: "t",
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: "https://github.com/o/r/pull/1",
    baseRef: "develop",
    headRef: "feature",
    createdAt: 0,
    updatedAt: 0,
    mergeStatus: "blocked",
    mergeIntent: null,
    headSha: "a".repeat(40),
    mergeQueueRequired: false,
    rawData: null,
    ...overrides,
  };
}

function meta(overrides: Partial<ForgeRepoMetadataPayload> = {}): ForgeRepoMetadataPayload {
  return {
    defaultBranch: "develop",
    isPrivate: false,
    isFork: false,
    isArchived: false,
    mergeSettings: {
      allowedMethods: ["merge", "squash"],
      viewerDefaultMethod: "squash",
      autoMergeAllowed: true,
    },
    autoMergeSupported: true,
    rawData: null,
    ...overrides,
  };
}

describe("derivePrMergeControl", () => {
  it.each(["blocked", "behind", "unknown"] as const)("offers auto-merge for %s", (status) => {
    expect(derivePrMergeControl(pr({ mergeStatus: status }), meta())).toEqual({
      kind: "arm",
      queue: false,
      methods: ["merge", "squash"],
      defaultMethod: "squash",
      baseRef: "develop",
      mergeStatus: status,
      disabledReason: null,
    });
  });

  it.each(["clean", "has_hooks", "unstable"] as const)("offers Merge for %s", (status) => {
    expect(derivePrMergeControl(pr({ mergeStatus: status }), meta()).kind).toBe("merge");
  });

  it("always arms on a queue branch, with no method choice", () => {
    expect(
      derivePrMergeControl(pr({ mergeStatus: "clean", mergeQueueRequired: true }), meta())
    ).toEqual({
      kind: "arm",
      queue: true,
      methods: [],
      defaultMethod: null,
      baseRef: "develop",
      mergeStatus: "clean",
      disabledReason: null,
    });
  });

  it("explains rather than hides when the repository has auto-merge off", () => {
    const model = derivePrMergeControl(
      pr(),
      meta({ mergeSettings: { allowedMethods: ["squash"], autoMergeAllowed: false } })
    );
    expect(model).toMatchObject({
      kind: "arm",
      disabledReason: AUTO_MERGE_OFF_REASON,
      methods: [],
    });
    // The switch governs arming only: an immediate merge is still offered.
    expect(
      derivePrMergeControl(
        pr({ mergeStatus: "clean" }),
        meta({ mergeSettings: { allowedMethods: ["squash"], autoMergeAllowed: false } })
      )
    ).toMatchObject({ kind: "merge", disabledReason: null });
  });

  it.each([
    ["draft", { isDraft: true }, "draft"],
    ["closed", { state: "closed" as const }, "closed"],
    ["merged", { state: "merged" as const, merged: true }, "merged"],
    ["conflicting", { mergeStatus: "dirty" as const }, "conflicts"],
    ["unreported", { mergeStatus: undefined }, "unreported"],
  ])("says why a %s PR can't merge rather than hiding the row", (_name, overrides, reason) => {
    expect(derivePrMergeControl(pr(overrides), meta())).toMatchObject({
      kind: "unavailable",
      reason,
    });
  });

  it("hides the row only when there is no PR to describe", () => {
    expect(derivePrMergeControl(null, meta()).kind).toBe("hidden");
  });

  it("keeps the row when the repository's settings couldn't be read", () => {
    expect(derivePrMergeControl(pr(), null)).toMatchObject({
      kind: "unavailable",
      reason: "settings-unread",
    });
    // What the PR alone decides still wins.
    expect(derivePrMergeControl(pr({ isDraft: true }), null)).toMatchObject({ reason: "draft" });
  });

  it("offers cancel for a pending merge, gated on GitHub's own cancel permission", () => {
    const intent = { kind: "auto-merge" as const, method: "squash" as const, enabledAt: 1 };
    expect(derivePrMergeControl(pr({ mergeIntent: intent }), meta())).toEqual({
      kind: "cancel",
      intent,
      baseRef: "develop",
      disabledReason: null,
    });
    expect(
      derivePrMergeControl(pr({ mergeIntent: intent, viewerCanDisableAutoMerge: false }), meta())
    ).toMatchObject({ disabledReason: CANNOT_CANCEL_REASON });
  });

  it("offers only the immediate merge when the provider can't arm", () => {
    const noAutoMerge = meta({ autoMergeSupported: false });
    expect(derivePrMergeControl(pr(), noAutoMerge)).toMatchObject({
      kind: "unavailable",
      reason: "no-auto-merge",
    });
    expect(derivePrMergeControl(pr({ mergeStatus: "clean" }), noAutoMerge).kind).toBe("merge");
  });

  it("re-decides the mode from a fresh read, never keeping a stale one", () => {
    expect(effectiveMergeMode(pr({ mergeStatus: "clean" }), "arm")).toBe("merge");
    expect(effectiveMergeMode(pr({ mergeStatus: "blocked" }), "merge")).toBe("arm");
    expect(effectiveMergeMode(pr({ mergeStatus: "clean" }), "cancel")).toBe("cancel");
  });

  it("keeps the request when the read reports no merge status", () => {
    expect(effectiveMergeMode(pr({ mergeStatus: undefined }), "merge")).toBe("merge");
    expect(effectiveMergeMode(pr({ mergeStatus: undefined }), "arm")).toBe("arm");
  });

  it("never guesses a method when the repository's list wasn't read", () => {
    expect(derivePrMergeControl(pr(), meta({ mergeSettings: undefined }))).toMatchObject({
      kind: "arm",
      defaultMethod: null,
      disabledReason: MERGE_SETTINGS_UNREAD_REASON,
    });
    // A queue branch needs no method of ours.
    expect(
      derivePrMergeControl(pr({ mergeQueueRequired: true }), meta({ mergeSettings: undefined }))
    ).toMatchObject({ kind: "arm", disabledReason: null });
  });
});

describe("confirmBlockReason", () => {
  const ok = { repository: "o/r", method: "squash" as const };

  it("lets a complete preview through", () => {
    expect(confirmBlockReason(pr({ commits: { totalCount: 0, items: [] } }), "arm", ok)).toBeNull();
  });

  it("re-checks eligibility against the confirm's own read", () => {
    const withCommits = { commits: { totalCount: 0, items: [] } };
    expect(confirmBlockReason(pr({ ...withCommits, isDraft: true }), "merge", ok)).toMatch(/draft/);
    expect(confirmBlockReason(pr({ ...withCommits, state: "closed" }), "merge", ok)).toMatch(
      /no longer open/
    );
    expect(
      confirmBlockReason(
        pr({ viewerCanDisableAutoMerge: false, mergeIntent: { kind: "queued", position: 1 } }),
        "cancel",
        ok
      )
    ).toBe(CANNOT_CANCEL_REASON);
  });

  it("won't cancel what GitHub no longer reports as pending", () => {
    expect(confirmBlockReason(pr({ mergeIntent: null }), "cancel", ok)).toMatch(/nothing pending/);
  });

  it("blocks a write when the read carries no merge status", () => {
    const withCommits = { commits: { totalCount: 0, items: [] } };
    expect(confirmBlockReason(pr({ ...withCommits, mergeStatus: undefined }), "arm", ok)).toBe(
      MERGE_STATUS_UNREPORTED_REASON
    );
  });
});

describe("mergeActionLabel", () => {
  it("keeps auto-merge and the merge queue in GitHub's own words", () => {
    expect(mergeActionLabel("arm")).toBe("Enable auto-merge");
    expect(mergeActionLabel("arm", { queue: true })).toBe("Merge when ready");
    expect(mergeActionLabel("cancel", { intent: { kind: "queued", position: 2 } })).toBe(
      "Remove from queue"
    );
  });
});

describe("merge outcomes", () => {
  const open = { prState: "open" as const, mergeIntent: null };

  it("shows a reported merge until detection catches up", () => {
    const outcome = { kind: "merged" as const, baseRef: "develop" };
    expect(applyMergeOutcome(outcome, open).prState).toBe("merged");
    expect(isMergeOutcomeReflected(outcome, open)).toBe(false);
    expect(isMergeOutcomeReflected(outcome, { prState: "merged", mergeIntent: null })).toBe(true);
  });

  it("changes nothing for a request GitHub didn't describe", () => {
    const outcome = { kind: "arm-requested" as const, queue: true };
    expect(applyMergeOutcome(outcome, open)).toEqual(open);
    expect(isMergeOutcomeReflected(outcome, open)).toBe(true);
  });
});

describe("describeMergeRejection", () => {
  const context = { baseRef: "develop", queue: false };

  it("names a moved head rather than repeating the CLI", () => {
    expect(
      describeMergeRejection(
        "GraphQL: Head branch was modified. (mergePullRequest)",
        "merge",
        context
      ).title
    ).toBe("New commits landed first");
  });

  it("names branch rules and what to wait for", () => {
    const rejected = describeMergeRejection(
      "Pull Request is not mergeable: the base branch policy prohibits the merge",
      "merge",
      context
    );
    expect(rejected.title).toBe("Branch rules blocked it");
    expect(rejected.summary).toMatch(/develop/);
  });

  it("falls back to what didn't happen", () => {
    expect(describeMergeRejection("something unexpected", "arm", context).title).toBe(
      "GitHub didn't enable auto-merge"
    );
  });
});
