import { afterEach, describe, expect, it } from "vitest";
import {
  buildIssueBranchMatcher,
  claimIssueFromBranch,
  getIssueBranchClaim,
  normalizeIssueBranchKeys,
  setIssueBranchClaim,
} from "../issueBranchClaim.js";

const LINEAR = "acme.linear.linear";

afterEach(() => {
  setIssueBranchClaim(null);
});

describe("normalizeIssueBranchKeys", () => {
  it("uppercases, dedupes and sorts longest first", () => {
    expect(normalizeIssueBranchKeys(["eng", "ENGX", "Eng", "des"])).toEqual(["ENGX", "DES", "ENG"]);
  });

  it("drops anything that isn't a literal key", () => {
    expect(
      normalizeIssueBranchKeys(["ENG", "E.*", "(A|B)", "1AB", "", "A".repeat(17), 42, null])
    ).toEqual(["ENG"]);
  });

  it("accepts keys with digits and underscores after the first letter", () => {
    expect(normalizeIssueBranchKeys(["PROJ_2", "A1"])).toEqual(["PROJ_2", "A1"]);
  });

  it("returns nothing for a non-array", () => {
    expect(normalizeIssueBranchKeys("ENG")).toEqual([]);
  });
});

describe("buildIssueBranchMatcher", () => {
  it("is null without valid keys", () => {
    expect(buildIssueBranchMatcher([])).toBeNull();
    expect(buildIssueBranchMatcher(["*"])).toBeNull();
  });
});

describe("claimIssueFromBranch", () => {
  it("claims nothing until a claim is installed", () => {
    expect(claimIssueFromBranch("eng-42-fix-login")).toBeNull();
  });

  it("claims the provider's keys in any case, with or without a user prefix", () => {
    setIssueBranchClaim({ providerId: LINEAR, keys: ["ENG"] });
    for (const branch of [
      "eng-42-fix-login",
      "jonathan/eng-42-fix-login",
      "ENG-42",
      "feature/Eng-42_x",
    ]) {
      expect(claimIssueFromBranch(branch)).toEqual({
        number: 42,
        issueProviderId: LINEAR,
        issueKey: "ENG-42",
      });
    }
  });

  it("only matches a key as a whole token", () => {
    setIssueBranchClaim({ providerId: LINEAR, keys: ["ENG"] });
    expect(claimIssueFromBranch("beng-42-fix")).toBeNull();
    expect(claimIssueFromBranch("eng-42x-fix")).toBeNull();
    expect(claimIssueFromBranch("fix-12-typo")).toBeNull();
    expect(claimIssueFromBranch("gh-7-readme")).toBeNull();
  });

  it("wins over a built-in pattern later in the same name", () => {
    setIssueBranchClaim({ providerId: LINEAR, keys: ["ENG"] });
    expect(claimIssueFromBranch("eng-42-fix-gh-7")?.issueKey).toBe("ENG-42");
  });

  it("prefers the longer of two overlapping keys", () => {
    setIssueBranchClaim({ providerId: LINEAR, keys: ["ENG", "ENGX"] });
    expect(claimIssueFromBranch("engx-5-thing")?.issueKey).toBe("ENGX-5");
  });

  it("falls back to the folder name", () => {
    setIssueBranchClaim({ providerId: LINEAR, keys: ["DES"] });
    expect(claimIssueFromBranch("my-feature", "des-9-redesign")?.issueKey).toBe("DES-9");
  });

  it("never claims a long-lived branch", () => {
    setIssueBranchClaim({ providerId: LINEAR, keys: ["MAIN", "RELEASE"] });
    expect(claimIssueFromBranch("main", "eng-1")).toBeNull();
    expect(claimIssueFromBranch("release/release-2")).toBeNull();
  });

  it("rejects a number beyond the safe-integer range", () => {
    setIssueBranchClaim({ providerId: LINEAR, keys: ["ENG"] });
    expect(claimIssueFromBranch("eng-99999999999999999999")).toBeNull();
    expect(claimIssueFromBranch("eng-0-zero")).toBeNull();
  });
});

describe("setIssueBranchClaim", () => {
  it("reports whether the claim changed", () => {
    expect(setIssueBranchClaim({ providerId: LINEAR, keys: ["eng"] })).toBe(true);
    expect(setIssueBranchClaim({ providerId: LINEAR, keys: ["ENG"] })).toBe(false);
    expect(setIssueBranchClaim({ providerId: LINEAR, keys: ["ENG", "DES"] })).toBe(true);
    expect(setIssueBranchClaim(null)).toBe(true);
    expect(setIssueBranchClaim(null)).toBe(false);
  });

  it("installs no claim for a provider with no valid keys", () => {
    setIssueBranchClaim({ providerId: LINEAR, keys: ["*"] });
    expect(getIssueBranchClaim()).toBeNull();
    expect(claimIssueFromBranch("eng-1")).toBeNull();
  });
});
