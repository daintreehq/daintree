import { describe, expect, it } from "vitest";
import type { PR } from "@shared/types/forge";
import type { ForgeRepoMetadataPayload } from "@shared/types/ipc/forge";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";
import {
  AUTO_MERGE_OFF_REASON,
  BYPASS_NOT_ALLOWED_REASON,
  CANNOT_CANCEL_REASON,
  MERGE_SETTINGS_UNREAD_REASON,
  MERGE_STATUS_UNREPORTED_REASON,
  applyMergeOutcome,
  canMergeWithoutWaiting,
  confirmBlockReason,
  derivePrMergeControl,
  describeMergeRejection,
  describeUnmetRequirements,
  effectiveMergeMode,
  isMergeOutcomeReflected,
  mergeActionLabel,
} from "../prMergeModel";
import { preparePrChecks } from "../prChecks";

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
      bypass: false,
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
      bypass: false,
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

  it("keeps a bypass request through a fresh read, and never turns it into an arm", () => {
    const admin = { viewerCanMergeAsAdmin: true };
    expect(effectiveMergeMode(pr(admin), "bypass")).toBe("bypass");
    // Allowed or not, it stays what was asked for, and the confirm blocks it.
    expect(effectiveMergeMode(pr({ viewerCanMergeAsAdmin: false }), "bypass")).toBe("bypass");
    expect(effectiveMergeMode(pr({ ...admin, mergeQueueRequired: true }), "bypass")).toBe("bypass");
    // Nothing left to skip: the ordinary merge.
    expect(effectiveMergeMode(pr({ ...admin, mergeStatus: "clean" }), "bypass")).toBe("merge");
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

describe("merge without waiting", () => {
  const admin = { viewerCanMergeAsAdmin: true };

  it.each(["blocked", "behind"] as const)(
    "is offered beside auto-merge when GitHub allows it on a %s PR",
    (status) => {
      expect(derivePrMergeControl(pr({ ...admin, mergeStatus: status }), meta())).toMatchObject({
        kind: "arm",
        disabledReason: null,
        bypass: true,
      });
    }
  );

  it.each([
    ["GitHub doesn't allow it", { viewerCanMergeAsAdmin: false }],
    ["GitHub didn't say", {}],
    ["the status is still being computed", { ...admin, mergeStatus: "unknown" as const }],
    ["the branch has a merge queue", { ...admin, mergeQueueRequired: true }],
    ["the merge queue went unreported", { ...admin, mergeQueueRequired: undefined }],
  ])("isn't offered when %s", (_name, overrides) => {
    expect(derivePrMergeControl(pr(overrides), meta())).toMatchObject({ bypass: false });
    expect(canMergeWithoutWaiting(pr(overrides))).toBe(false);
  });

  it.each([
    ["a draft", { isDraft: true }, "draft"],
    ["a conflicting PR", { mergeStatus: "dirty" as const }, "conflicts"],
  ])("isn't offered on %s", (_name, overrides, reason) => {
    expect(derivePrMergeControl(pr({ ...admin, ...overrides }), meta())).toMatchObject({
      kind: "unavailable",
      reason,
    });
    expect(canMergeWithoutWaiting(pr({ ...admin, ...overrides }))).toBe(false);
  });

  it("isn't offered for a PR that can merge now, whatever GitHub allows", () => {
    expect(derivePrMergeControl(pr({ ...admin, mergeStatus: "clean" }), meta())).toMatchObject({
      kind: "merge",
      bypass: false,
    });
  });

  it("stays available when auto-merge is off, which only disables the arm", () => {
    expect(
      derivePrMergeControl(
        pr(admin),
        meta({ mergeSettings: { allowedMethods: ["squash"], autoMergeAllowed: false } })
      )
    ).toMatchObject({
      kind: "arm",
      disabledReason: AUTO_MERGE_OFF_REASON,
      defaultMethod: "squash",
      bypass: true,
    });
  });

  it("isn't offered without a method to preview", () => {
    expect(derivePrMergeControl(pr(admin), meta({ mergeSettings: undefined }))).toMatchObject({
      disabledReason: MERGE_SETTINGS_UNREAD_REASON,
      bypass: false,
    });
  });

  it("is blocked on the confirm's read once it no longer applies", () => {
    const ok = { repository: "o/r", method: "squash" as const };
    const ready = { ...admin, commits: { totalCount: 0, items: [] } };
    expect(confirmBlockReason(pr(ready), "bypass", ok)).toBeNull();
    expect(confirmBlockReason(pr({ ...ready, viewerCanMergeAsAdmin: false }), "bypass", ok)).toBe(
      BYPASS_NOT_ALLOWED_REASON
    );
    expect(confirmBlockReason(pr({ ...ready, mergeQueueRequired: true }), "bypass", ok)).toMatch(
      /merge queue/
    );
    expect(
      confirmBlockReason(pr({ ...ready, mergeQueueRequired: undefined }), "bypass", ok)
    ).toMatch(/merge queue/);
    expect(
      confirmBlockReason(pr({ ...ready, mergeStatus: "unknown" }), "bypass", ok)
    ).not.toBeNull();
    expect(confirmBlockReason(pr(ready), "bypass", { ...ok, method: null })).toBe(
      MERGE_SETTINGS_UNREAD_REASON
    );
  });

  it("is worded as skipping the requirements", () => {
    expect(mergeActionLabel("bypass")).toBe("Merge without waiting");
  });
});

describe("describeUnmetRequirements", () => {
  const run = (overrides: Partial<ForgeCheckRun>): ForgeCheckRun => ({
    name: "build",
    status: "completed",
    conclusion: "success",
    ...overrides,
  });

  it("names what GitHub reports is unmet, and only the required checks that haven't passed", () => {
    const checks = preparePrChecks([
      run({ name: "build", conclusion: "failure", required: true }),
      run({ name: "e2e", status: "in_progress", conclusion: undefined, required: true }),
      run({ name: "lint", conclusion: "failure", required: false }),
      run({ name: "unit", conclusion: "success", required: true }),
      run({ name: "docs", conclusion: "skipped", required: true }),
    ]);
    expect(
      describeUnmetRequirements(
        pr({ mergeStatus: "behind", reviewDecision: "REVIEW_REQUIRED" }),
        checks
      )
    ).toEqual({
      items: [
        "Not up to date with develop",
        "Approving review required",
        "Required check build: Failed",
        "Required check e2e: Running",
      ],
      checksUnread: false,
    });
  });

  it("names requested changes", () => {
    expect(
      describeUnmetRequirements(pr({ reviewDecision: "CHANGES_REQUESTED" }), []).items
    ).toEqual(["Changes requested"]);
  });

  it.each([
    [5, 5, null],
    [6, 5, "1 more required check not passed"],
    [8, 5, "3 more required checks not passed"],
  ])(
    "names the first few of %i unmet required checks and counts the rest",
    (total, named, rest) => {
      const checks = preparePrChecks(
        Array.from({ length: total }, (_, i) =>
          run({ name: `job${i}`, conclusion: "failure", required: true })
        )
      );
      const { items } = describeUnmetRequirements(pr(), checks);
      expect(items.filter((item) => item.startsWith("Required check "))).toHaveLength(named);
      expect(items.at(-1)).toBe(rest ?? `Required check job${named - 1}: Failed`);
    }
  );

  it("says the branch rules aren't met when GitHub itemised nothing, never guessing which", () => {
    expect(describeUnmetRequirements(pr({ reviewDecision: "APPROVED" }), [])).toEqual({
      items: ["Branch rules on develop not met"],
      checksUnread: false,
    });
  });

  it("claims no unmet branch rules GitHub didn't report", () => {
    expect(describeUnmetRequirements(pr({ mergeStatus: "behind" }), []).items).toEqual([
      "Not up to date with develop",
    ]);
    expect(describeUnmetRequirements(pr({ mergeStatus: "unknown" }), []).items).toEqual([]);
  });

  it("says when the checks couldn't be read", () => {
    expect(describeUnmetRequirements(pr(), null)).toEqual({
      items: ["Branch rules on develop not met"],
      checksUnread: true,
    });
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

  it("says GitHub refused a merge without waiting, without blaming conflicts it didn't name", () => {
    const message =
      "Pull request #42 is not mergeable — it may be a draft, have conflicts, or fail required checks.";
    expect(describeMergeRejection(message, "bypass", context).title).toBe(
      "GitHub didn't allow merging without waiting"
    );
    // A moved head is still named for what it is.
    expect(
      describeMergeRejection(
        "Head branch was modified. Review and try the merge again.",
        "bypass",
        context
      ).title
    ).toBe("New commits landed first");
    expect(describeMergeRejection("something unexpected", "bypass", context).title).toBe(
      "GitHub didn't merge it"
    );
  });

  it("falls back to what didn't happen", () => {
    expect(describeMergeRejection("something unexpected", "arm", context).title).toBe(
      "GitHub didn't enable auto-merge"
    );
  });
});
