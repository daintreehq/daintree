import { strict as assert } from "node:assert";
import { test } from "node:test";
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

test("parseMetadata extracts valid metadata", () => {
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
  assert.ok(meta);
  assert.equal(meta.signature, "abcdef123456");
  assert.equal(meta.consecutive_failures, 2);
  assert.equal(meta.first_seen, "2026-05-20");
  assert.equal(meta.last_seen, "2026-05-28");
  assert.equal(meta.last_seen_run_id, 12345);
});

test("parseMetadata returns null for missing marker", () => {
  assert.equal(parseMetadata("no metadata here"), null);
  assert.equal(parseMetadata(null), null);
});

test("parseMetadata returns null for invalid JSON in marker", () => {
  assert.equal(parseMetadata("<!-- METADATA:\n{invalid}\n-->"), null);
});

test("parseMetadata returns null for missing signature", () => {
  assert.equal(parseMetadata('<!-- METADATA:\n{"consecutive_failures": 1}\n-->'), null);
});

test("parseMetadata returns null for wrong signature length", () => {
  assert.equal(parseMetadata('<!-- METADATA:\n{"signature": "abc"}\n-->'), null);
});

test("buildMetadataBlock round-trips through parseMetadata", () => {
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
  assert.deepEqual(parsed, original);
});

test("buildMetadataBlock produces valid marker", () => {
  const block = buildMetadataBlock({
    signature: "abcdef123456",
    consecutive_failures: 1,
    first_seen: "2026-05-28",
    last_seen: "2026-05-28",
    last_seen_run_id: 1,
    last_green_run_url: null,
  });
  assert.ok(block.startsWith("<!-- METADATA:"));
  assert.ok(block.endsWith("-->"));
  assert.ok(block.includes('"abcdef123456"'));
});

test("buildIssueTitle", () => {
  const report = {
    projectName: "full-terminal",
    titlePath: ["root", "Search", "should find text"],
  };
  const title = buildIssueTitle(report);
  assert.ok(title.includes("[Nightly]"));
  assert.ok(title.includes("full-terminal"));
  assert.ok(title.includes("should find text"));
});

test("buildIssueTitle truncates long titles", () => {
  const report = {
    projectName: "core",
    titlePath: [
      "root",
      "A very long test name that exceeds sixty characters and should be truncated",
    ],
  };
  const title = buildIssueTitle(report);
  assert.ok(title.length <= 80);
  assert.ok(title.endsWith("..."));
});

test("buildIssueBody contains key info", () => {
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
  assert.ok(body.includes("e2e/core/test.spec.ts"));
  assert.ok(body.includes("should work"));
  assert.ok(body.includes("Expected 1 got 2"));
  assert.ok(body.includes("Linux"));
  assert.ok(body.includes("METADATA:"));
});

test("nextMetadata creates new metadata", () => {
  const report = { signature: "abcdef123456" };
  const meta = nextMetadata(null, report, 1, "https://run", "2026-05-28");
  assert.equal(meta.signature, "abcdef123456");
  assert.equal(meta.consecutive_failures, 1);
  assert.equal(meta.first_seen, "2026-05-28");
  assert.equal(meta.last_seen, "2026-05-28");
  assert.equal(meta.last_seen_run_id, 1);
});

test("nextMetadata skips increment on same run_id", () => {
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
  assert.equal(meta.consecutive_failures, 2);
});

test("nextMetadata increments on consecutive day", () => {
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
  assert.equal(meta.consecutive_failures, 3);
});

test("nextMetadata resets on non-consecutive day", () => {
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
  assert.equal(meta.consecutive_failures, 1);
});

test("nextMetadata preserves first_seen", () => {
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
  assert.equal(meta.first_seen, "2026-05-20");
});

test("shouldEscalateToHumanReview at threshold", () => {
  assert.equal(shouldEscalateToHumanReview({ consecutive_failures: 2 }), false);
  assert.equal(shouldEscalateToHumanReview({ consecutive_failures: 3 }), true);
  assert.equal(shouldEscalateToHumanReview({ consecutive_failures: 5 }), true);
});

test("shouldCloseOnGreen", () => {
  assert.equal(shouldCloseOnGreen({ last_seen: "2026-05-27" }, "2026-05-28"), true);
  assert.equal(shouldCloseOnGreen({ last_seen: "2026-05-28" }, "2026-05-28"), false);
  assert.equal(shouldCloseOnGreen(null, "2026-05-28"), false);
});

test("shouldStaleClose after 14 days", () => {
  assert.equal(shouldStaleClose({ last_seen: "2026-05-13" }, "2026-05-28"), true);
  assert.equal(shouldStaleClose({ last_seen: "2026-05-14" }, "2026-05-28"), false);
  assert.equal(shouldStaleClose(null, "2026-05-28"), false);
});

test("findIssueBySignature", () => {
  const issues = [
    { number: 1, metadata: { signature: "aaaa11112222" } },
    { number: 2, metadata: { signature: "bbbb33334444" } },
    { number: 3, metadata: null },
  ];
  const found = findIssueBySignature(issues, "bbbb33334444");
  assert.equal(found.number, 2);
  assert.equal(findIssueBySignature(issues, "nope"), undefined);
});

test("deduplicateReports merges same signature with oses array", () => {
  const reports = [
    { signature: "abc123", projectName: "core", os: "Linux" },
    { signature: "abc123", projectName: "core", os: "macOS" },
    { signature: "def456", projectName: "full-terminal", os: "Linux" },
  ];
  const deduped = deduplicateReports(reports);
  assert.equal(deduped.length, 2);
  const merged = deduped.find((d) => d.signature === "abc123");
  assert.ok(merged);
  assert.deepEqual(merged.oses, ["Linux", "macOS"]);
  // input reports not mutated
  assert.ok(!("oses" in reports[0]));
});

test("labelsForIssue", () => {
  const labels = labelsForIssue({ projectName: "full-terminal" });
  assert.ok(labels.includes("nightly-failure"));
  assert.ok(labels.includes("full-terminal"));
});

test("labelsForEscalation", () => {
  assert.deepEqual(labelsForEscalation({ consecutive_failures: 2 }), []);
  assert.ok(labelsForEscalation({ consecutive_failures: 3 }).includes("human-review"));
});

test("buildRecoveredComment", () => {
  const comment = buildRecoveredComment("https://github.com/org/repo/actions/runs/5");
  assert.ok(comment.includes("did not recur"));
  assert.ok(comment.includes("/actions/runs/5"));
});
