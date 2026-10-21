import { describe, expect, it } from "vitest";
import { issueBranchName } from "../issueBranchName.js";

describe("issueBranchName (#13700)", () => {
  it("uses the provider's suggestion verbatim", () => {
    expect(issueBranchName({ branchName: "greg/eng-123-fix-login" }, "feature/issue-123-x")).toBe(
      "greg/eng-123-fix-login"
    );
  });

  it("falls back when the provider suggests nothing", () => {
    expect(issueBranchName({}, "feature/issue-42-fix")).toBe("feature/issue-42-fix");
    expect(issueBranchName({ branchName: "   " }, "feature/issue-42-fix")).toBe(
      "feature/issue-42-fix"
    );
    expect(issueBranchName(null, "issue-42")).toBe("issue-42");
  });

  it("falls back rather than creating a branch git would reject", () => {
    for (const bad of ["has space", "a..b", "-leading", "trailing/", "x~1"]) {
      expect(issueBranchName({ branchName: bad }, "issue-42")).toBe("issue-42");
    }
  });

  it("trims surrounding whitespace off a usable suggestion", () => {
    expect(issueBranchName({ branchName: "  eng-1-x \n" }, "issue-1")).toBe("eng-1-x");
  });
});
