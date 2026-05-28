import { describe, it, expect } from "vitest";
import {
  buildDiagnosticsIssueUrl,
  capForBudget,
  makeUrl,
  REPO_ISSUE_URL,
  truncateStackMiddle,
  TITLE_ENCODED_BUDGET,
  URL_BODY_BUDGET,
} from "../githubIssueUrl.js";

function body(url: string): string {
  return new URL(url).searchParams.get("body") ?? "";
}

function title(url: string): string {
  return new URL(url).searchParams.get("title") ?? "";
}

describe("buildDiagnosticsIssueUrl", () => {
  const meta = {
    appVersion: "1.2.3",
    electronVersion: "41.0.0",
    nodeVersion: "22.0.0",
    platform: "darwin",
    osVersion: "Darwin 25.5.0",
  };

  it("targets the repo issue form", () => {
    expect(buildDiagnosticsIssueUrl(meta).startsWith(REPO_ISSUE_URL)).toBe(true);
  });

  it("includes the environment summary", () => {
    const b = body(buildDiagnosticsIssueUrl(meta));
    expect(b).toContain("1.2.3");
    expect(b).toContain("41.0.0");
    expect(b).toContain("22.0.0");
    expect(b).toContain("darwin");
    expect(b).toContain("Darwin 25.5.0");
  });

  it("includes the repro skeleton and the ZIP attachment note", () => {
    const b = body(buildDiagnosticsIssueUrl(meta));
    expect(b).toContain("Steps to reproduce");
    expect(b).toContain("drag the saved ZIP into this issue");
  });

  it("falls back to an unknown marker when no metadata is given", () => {
    const b = body(buildDiagnosticsIssueUrl({}));
    expect(b).toContain("_(unknown)_");
  });

  it("stays within the encoded URL body budget", () => {
    const encoded = encodeURIComponent(body(buildDiagnosticsIssueUrl(meta))).length;
    expect(encoded).toBeLessThanOrEqual(URL_BODY_BUDGET);
  });
});

describe("capForBudget", () => {
  it("returns short values unchanged", () => {
    expect(capForBudget("hello", 100)).toBe("hello");
  });

  it("truncates with an ellipsis and fits the budget", () => {
    const result = capForBudget("a".repeat(500), 100);
    expect(result.endsWith("…")).toBe(true);
    expect(encodeURIComponent(result).length).toBeLessThanOrEqual(100);
  });

  it("does not slice into a multi-byte surrogate pair", () => {
    const result = capForBudget("😀".repeat(100), 20);
    // Each "😀" encodes to 12 bytes via encodeURIComponent; the result must
    // still be a valid string (no lone surrogate) and fit the budget.
    expect(encodeURIComponent(result).length).toBeLessThanOrEqual(20);
    expect([...result].every((c) => c === "😀" || c === "…")).toBe(true);
  });
});

describe("makeUrl", () => {
  it("caps an over-long title to the title budget", () => {
    const url = makeUrl("T".repeat(1000), "body");
    expect(encodeURIComponent(title(url)).length).toBeLessThanOrEqual(TITLE_ENCODED_BUDGET);
  });
});

describe("truncateStackMiddle", () => {
  it("leaves a short stack untouched", () => {
    const stack = "line1\nline2\nline3";
    expect(truncateStackMiddle(stack)).toBe(stack);
  });

  it("middle-truncates a long stack with a visible placeholder", () => {
    const stack = Array.from({ length: 40 }, (_, i) => `frame ${i}`).join("\n");
    const result = truncateStackMiddle(stack);
    expect(result).toContain("middle frames truncated");
    expect(result.split("\n").length).toBeLessThan(40);
    // Head and tail frames are preserved.
    expect(result).toContain("frame 0");
    expect(result).toContain("frame 39");
  });
});
