import { describe, expect, it } from "vitest";
import { classifyArchiveReplacement } from "../archiveReplacement";

describe("classifyArchiveReplacement", () => {
  it("orders the archive against the installed version", () => {
    expect(classifyArchiveReplacement("1.0.0", "1.2.3")).toBe("upgrade");
    expect(classifyArchiveReplacement("2.0.0", "1.2.3")).toBe("downgrade");
    expect(classifyArchiveReplacement("1.2.3", "1.2.3")).toBe("reinstall");
  });

  it("ranks a prerelease below its release", () => {
    expect(classifyArchiveReplacement("1.2.3-beta.1", "1.2.3")).toBe("upgrade");
    expect(classifyArchiveReplacement("1.2.3", "1.2.3-beta.1")).toBe("downgrade");
    expect(classifyArchiveReplacement("1.2.3-beta.2", "1.2.3-beta.10")).toBe("upgrade");
  });

  it("calls a build-metadata-only difference neither newer nor the same", () => {
    // semver ranks these equal, but the strings name different builds.
    expect(classifyArchiveReplacement("1.2.3+build.1", "1.2.3+build.2")).toBe("replace");
  });

  it("doesn't guess a direction for a version semver can't read", () => {
    expect(classifyArchiveReplacement("latest", "1.2.3")).toBe("replace");
    expect(classifyArchiveReplacement("1.2.3", "v-next")).toBe("replace");
    expect(classifyArchiveReplacement("latest", "latest")).toBe("reinstall");
  });
});
