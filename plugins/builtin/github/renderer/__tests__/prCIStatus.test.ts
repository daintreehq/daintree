import { describe, expect, it } from "vitest";
import type { CIStatusState } from "@shared/types/forge";
import { getPRStatusTooltip, getPRStatusVisual } from "../utils/prCIStatus";

describe("getPRStatusVisual / getPRStatusTooltip", () => {
  it.each<[CIStatusState | undefined]>([
    [undefined],
    ["success"],
    ["failure"],
    ["pending"],
    ["neutral"],
    ["unknown"],
  ])("a reported conflict wins over a %s roll-up", (ciStatus) => {
    const visual = getPRStatusVisual(ciStatus, "conflicts");
    expect(visual?.kind).toBe("icon");
    expect(visual?.ariaLabel).toBe("Merge conflicts");
    expect(visual?.colorClass).toBe("text-status-warning");
    expect(getPRStatusTooltip(ciStatus, "conflicts")).toBe(
      "Merge conflicts with the base branch — GitHub skips pull_request workflows until they're resolved"
    );
  });

  it("falls through to the CI roll-up without a conflict", () => {
    expect(getPRStatusVisual("success", undefined)?.ariaLabel).toBe("CI passing");
    expect(getPRStatusVisual("failure", undefined)?.ariaLabel).toBe("CI failing");
    expect(getPRStatusVisual("pending", undefined)?.kind).toBe("dot");
    expect(getPRStatusTooltip("failure", undefined)).toBe("Checks failing");
  });

  it("renders nothing when neither signal is present", () => {
    expect(getPRStatusVisual(undefined, undefined)).toBeNull();
    expect(getPRStatusTooltip(undefined, undefined)).toBeNull();
    expect(getPRStatusVisual("neutral", undefined)).toBeNull();
  });
});
