import { describe, it, expect } from "vitest";
import {
  buildMetadataBlock,
  buildIssueBody,
  buildIssueTitle,
  buildRecoveredComment,
  deduplicateReports,
  findIssueBySignature,
  labelsForEscalation,
  labelsForIssue,
  nextMetadata,
  parseMetadata,
  shouldCloseOnGreen,
  shouldEscalateToHumanReview,
  shouldStaleClose,
} from "./process-nightly-issues.mjs";

it("parseMetadata extracts valid metadata", () => {
  const body = `
Some content
<!-- METADATA:
{
  "signature": "abcdef123456",
  "consecutive_failures": 2,
  "first_seen": "2026-05-20",
  "last_seen": "2026-05-28",
  "last_seen_run_id": 12345,
  "last_green_run_url": null
}
-->
More content
`;
  const meta = parseMetadata(body);
  expect(meta).toBeTruthy();
  expect(meta.signature).toBe("abcdef123456");
  expect(meta.consecutive_failures).toBe(2);
  expect(meta.first_seen).toBe("2026-05-20");
  expect(meta.last_seen).toBe("2026-05-28");
  expect(meta.last_seen_run_id).toBe(12345);
});

it("parseMetadata returns null for missing marker", () => {
  expect(parseMetadata("no metadata here")).toBe(null);
  expect(parseMetadata(null)).toBe(null);
});

it("parseMetadata returns null for invalid JSON in marker", () => {
  expect(parseMetadata("<!-- METADATA:\n{invalid}\n-->")).toBe(null);
});

it("parseMetadata returns null for missing signature", () => {
  expect(parseMetadata('<!-- METADATA:\n{"consecutive_failures": 1}\n-->')).toBe(null);
});

it("parseMetadata returns null for wrong signature length", () => {
  expect(parseMetadata('<!-- METADATA:\n{"signature": "abc"}\n-->')).toBe(null);
});

it("buildMetadataBlock round-trips through parseMetadata", () => {
  const original = {
    signature: "deadbeef1234",
    consecutive_failures: 3,
    first_seen: "2026-05-20",
    last_seen: "2026-05-28",
    last_seen_run_id: 99999,
    last_green_run_url: null,
  };
  const block = buildMetadataBlock(original);
  const parsed = parseMetadata(block);
  expect(parsed).toEqual(original);
});

it("buildMetadataBlock produces valid marker", () => {
  const block = buildMetadataBlock({
    signature: "abcdef123456",
    consecutive_failures: 1,
    first_seen: "2026-05-28",
    last_seen: "2026-05-28",
    last_seen_run_id: 1,
    last_green_run_url: null,
  });
  expect(block.startsWith("<!-- METADATA:")).toBeTruthy();
  expect(block.endsWith("-->")).toBeTruthy();
  expect(block).toContain('"abcdef123456"');
});

it("buildIssueTitle", () => {
  const report = {
    projectName: "full-terminal",
    titlePath: ["root", "Search", "should find text"],
  };
  const title = buildIssueTitle(report);
  expect(title).toContain("[Nightly]");
  expect(title).toContain("full-terminal");
  expect(title).toContain("should find text");
});

it("buildIssueTitle truncates long titles", () => {
  const report = {
    projectName: "core",
    titlePath: [
      "root",
      "A very long test name that exceeds sixty characters and should be truncated",
    ],
  };
  const title = buildIssueTitle(report);
  expect(title.length).toBeLessThanOrEqual(80);
  expect(title.endsWith("...")).toBeTruthy();
});

it("buildIssueBody contains key info", () => {
  const report = {
    projectName: "core",
    file: "e2e/core/test.spec.ts",
    titlePath: ["root", "should work"],
    rawError: "Expected 1 got 2",
    normalizedError: "Expected 1 got 2",
    os: "Linux",
    signature: "abcdef123456",
  };
  const metadata = {
    signature: "abcdef123456",
    consecutive_failures: 1,
    first_seen: "2026-05-28",
    last_seen: "2026-05-28",
    last_seen_run_id: 1,
    last_green_run_url: null,
  };
  const body = buildIssueBody(report, metadata, "https://github.com/org/repo/actions/runs/1");
  expect(body).toContain("e2e/core/test.spec.ts");
  expect(body).toContain("should work");
  expect(body).toContain("Expected 1 got 2");
  expect(body).toContain("Linux");
  expect(body).toContain("METADATA:");
});

it("nextMetadata creates new metadata", () => {
  const report = { signature: "abcdef123456" };
  const meta = nextMetadata(null, report, 1, "https://run", "2026-05-28");
  expect(meta.signature).toBe("abcdef123456");
  expect(meta.consecutive_failures).toBe(1);
  expect(meta.first_seen).toBe("2026-05-28");
  expect(meta.last_seen).toBe("2026-05-28");
  expect(meta.last_seen_run_id).toBe(1);
});

it("nextMetadata skips increment on same run_id", () => {
  const existing = {
    signature: "abcdef123456",
    consecutive_failures: 2,
    first_seen: "2026-05-26",
    last_seen: "2026-05-28",
    last_seen_run_id: 1,
    last_green_run_url: null,
  };
  const report = { signature: "abcdef123456" };
  const meta = nextMetadata(existing, report, 1, "https://run", "2026-05-28");
  expect(meta.consecutive_failures).toBe(2);
});

it("nextMetadata increments on consecutive day", () => {
  const existing = {
    signature: "abcdef123456",
    consecutive_failures: 2,
    first_seen: "2026-05-26",
    last_seen: "2026-05-27",
    last_seen_run_id: 999,
    last_green_run_url: null,
  };
  const report = { signature: "abcdef123456" };
  const meta = nextMetadata(existing, report, 1, "https://run", "2026-05-28");
  expect(meta.consecutive_failures).toBe(3);
});

it("nextMetadata resets on non-consecutive day", () => {
  const existing = {
    signature: "abcdef123456",
    consecutive_failures: 2,
    first_seen: "2026-05-20",
    last_seen: "2026-05-25",
    last_seen_run_id: 999,
    last_green_run_url: null,
  };
  const report = { signature: "abcdef123456" };
  const meta = nextMetadata(existing, report, 1, "https://run", "2026-05-28");
  expect(meta.consecutive_failures).toBe(1);
});

it("nextMetadata preserves first_seen", () => {
  const existing = {
    signature: "abcdef123456",
    consecutive_failures: 1,
    first_seen: "2026-05-20",
    last_seen: "2026-05-27",
    last_seen_run_id: 999,
    last_green_run_url: null,
  };
  const report = { signature: "abcdef123456" };
  const meta = nextMetadata(existing, report, 2, "https://run", "2026-05-28");
  expect(meta.first_seen).toBe("2026-05-20");
});

it("shouldEscalateToHumanReview at threshold", () => {
  expect(shouldEscalateToHumanReview({ consecutive_failures: 2 })).toBe(false);
  expect(shouldEscalateToHumanReview({ consecutive_failures: 3 })).toBe(true);
  expect(shouldEscalateToHumanReview({ consecutive_failures: 5 })).toBe(true);
});

it("shouldCloseOnGreen", () => {
  expect(shouldCloseOnGreen({ last_seen: "2026-05-27" }, "2026-05-28")).toBe(true);
  expect(shouldCloseOnGreen({ last_seen: "2026-05-28" }, "2026-05-28")).toBe(false);
  expect(shouldCloseOnGreen(null, "2026-05-28")).toBe(false);
});

it("shouldStaleClose after 14 days", () => {
  expect(shouldStaleClose({ last_seen: "2026-05-13" }, "2026-05-28")).toBe(true);
  expect(shouldStaleClose({ last_seen: "2026-05-14" }, "2026-05-28")).toBe(false);
  expect(shouldStaleClose(null, "2026-05-28")).toBe(false);
});

it("findIssueBySignature", () => {
  const issues = [
    { number: 1, metadata: { signature: "aaaa11112222" } },
    { number: 2, metadata: { signature: "bbbb33334444" } },
    { number: 3, metadata: null },
  ];
  const found = findIssueBySignature(issues, "bbbb33334444");
  expect(found.number).toBe(2);
  expect(findIssueBySignature(issues, "nope")).toBeUndefined();
});

it("deduplicateReports merges same signature with oses array", () => {
  const reports = [
    { signature: "abc123", projectName: "core", os: "Linux" },
    { signature: "abc123", projectName: "core", os: "macOS" },
    { signature: "def456", projectName: "full-terminal", os: "Linux" },
  ];
  const deduped = deduplicateReports(reports);
  expect(deduped.length).toBe(2);
  const merged = deduped.find((d) => d.signature === "abc123");
  expect(merged).toBeTruthy();
  expect(merged.oses).toEqual(["Linux", "macOS"]);
  // input reports not mutated
  expect("oses" in reports[0]).toBeFalsy();
});

it("labelsForIssue", () => {
  const labels = labelsForIssue({ projectName: "full-terminal" });
  expect(labels).toContain("nightly-failure");
  expect(labels).toContain("full-terminal");
});

it("labelsForEscalation", () => {
  expect(labelsForEscalation({ consecutive_failures: 2 })).toEqual([]);
  expect(labelsForEscalation({ consecutive_failures: 3 })).toContain("human-review");
});

it("buildRecoveredComment", () => {
  const comment = buildRecoveredComment("https://github.com/org/repo/actions/runs/5");
  expect(comment).toContain("did not recur");
  expect(comment).toContain("/actions/runs/5");
});
