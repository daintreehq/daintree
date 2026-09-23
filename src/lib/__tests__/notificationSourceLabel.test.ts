import { describe, expect, it } from "vitest";
import { formatNotificationSource, worktreeNameFromId } from "../notificationSourceLabel";

describe("notification source labels", () => {
  it("names a worktree by its path's last segment on either separator", () => {
    expect(worktreeNameFromId("/a/b/feature-x")).toBe("feature-x");
    expect(worktreeNameFromId("C:\\\\a\\\\b\\\\feature-x\\\\")).toBe("feature-x");
  });

  it("says a place once when the worktree is named after its project", () => {
    const repeated = formatNotificationSource("Helios", "Helios");
    const distinct = formatNotificationSource("Helios", "feature-x");
    expect(repeated).toBe(formatNotificationSource("Helios"));
    expect(distinct).toContain("Helios");
    expect(distinct).toContain("feature-x");
  });

  it("has nothing to say when there is no place", () => {
    expect(formatNotificationSource(undefined, "  ")).toBeNull();
  });
});
