import { describe, expect, it } from "vitest";
import type { PR } from "@shared/types/forge";
import type { ForgeRepoMetadataPayload } from "@shared/types/ipc/forge";
import {
  AUTO_MERGE_OFF_REASON,
  CANNOT_CANCEL_REASON,
  derivePrMergeControl,
  effectiveMergeMode,
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
  it.each(["blocked", "behind", "unknown"] as const)("offers Merge when ready for %s", (status) => {
    expect(derivePrMergeControl(pr({ mergeStatus: status }), meta())).toEqual({
      kind: "arm",
      queue: false,
      methods: ["merge", "squash"],
      defaultMethod: "squash",
      disabledReason: null,
    });
  });

  it.each(["clean", "has_hooks", "unstable"] as const)("offers Merge for %s", (status) => {
    expect(derivePrMergeControl(pr({ mergeStatus: status }), meta()).kind).toBe("merge");
  });

  it("always arms on a queue branch, with no method choice", () => {
    expect(
      derivePrMergeControl(pr({ mergeStatus: "clean", mergeQueueRequired: true }), meta())
    ).toEqual({ kind: "arm", queue: true, methods: [], defaultMethod: null, disabledReason: null });
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
    ["draft", { isDraft: true }],
    ["closed", { state: "closed" as const }],
    ["merged", { state: "merged" as const, merged: true }],
    ["conflicting", { mergeStatus: "dirty" as const }],
    ["unreported", { mergeStatus: undefined }],
  ])("hides the control for a %s PR", (_name, overrides) => {
    expect(derivePrMergeControl(pr(overrides), meta()).kind).toBe("hidden");
  });

  it("offers cancel for a pending merge, gated on GitHub's own cancel permission", () => {
    const intent = { kind: "auto-merge" as const, method: "squash" as const, enabledAt: 1 };
    expect(derivePrMergeControl(pr({ mergeIntent: intent }), meta())).toEqual({
      kind: "cancel",
      intent,
      disabledReason: null,
    });
    expect(
      derivePrMergeControl(pr({ mergeIntent: intent, viewerCanDisableAutoMerge: false }), meta())
    ).toMatchObject({ disabledReason: CANNOT_CANCEL_REASON });
  });

  it("offers only the immediate merge when the provider can't arm", () => {
    const noAutoMerge = meta({ autoMergeSupported: false });
    expect(derivePrMergeControl(pr(), noAutoMerge).kind).toBe("hidden");
    expect(derivePrMergeControl(pr({ mergeStatus: "clean" }), noAutoMerge).kind).toBe("merge");
  });

  it("re-decides the mode from a fresh read, never keeping a stale one", () => {
    expect(effectiveMergeMode(pr({ mergeStatus: "clean" }), "arm")).toBe("merge");
    expect(effectiveMergeMode(pr({ mergeStatus: "blocked" }), "merge")).toBe("arm");
    expect(effectiveMergeMode(pr({ mergeStatus: "clean" }), "cancel")).toBe("cancel");
  });
});
