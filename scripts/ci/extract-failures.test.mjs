import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeSignature, extractFailures, normalizeError } from "./extract-failures.mjs";

test("normalizeError strips paths", () => {
  const input = "Error at /Users/test/project/src/file.ts:42:10";
  const result = normalizeError(input);
  assert.ok(!result.includes("/Users/test/project"));
  assert.ok(result.includes("<path>"));
});

test("normalizeError strips timestamps", () => {
  const input = "Failed at 2025-06-15T03:00:00.123Z";
  const result = normalizeError(input);
  assert.ok(!result.includes("2025-06-15"));
  assert.ok(result.includes("<timestamp>"));
});

test("normalizeError strips line:col", () => {
  const input = "Error at file.ts:42:10 and also file.ts:100:5";
  const result = normalizeError(input);
  assert.ok(!result.includes(":42:10"));
  assert.ok(!result.includes(":100:5"));
  assert.ok(result.includes(":<line>:<col>"));
});

test("normalizeError strips memory addresses", () => {
  const input = "Segfault at 0x7fff5fbff000 and 0xDEADBEEF1234";
  const result = normalizeError(input);
  assert.ok(!result.includes("0x7fff5fbff000"));
  assert.ok(!result.includes("0xDEADBEEF1234"));
  assert.ok(result.includes("0x<addr>"));
});

test("normalizeError strips UUIDs", () => {
  const input = "Session abc123de-4567-8901-abcd-ef1234567890 not found";
  const result = normalizeError(input);
  assert.ok(!result.includes("abc123de-4567-8901-abcd-ef1234567890"));
  assert.ok(result.includes("<uuid>"));
});

test("normalizeError strips ports", () => {
  const input = "Connection refused on localhost:9222";
  const result = normalizeError(input);
  assert.ok(!result.includes(":9222"));
});

test("computeSignature is deterministic", () => {
  const sig1 = computeSignature("spec.ts", ["suite", "test name"], "Error: things broke");
  const sig2 = computeSignature("spec.ts", ["suite", "test name"], "Error: things broke");
  assert.equal(sig1, sig2);
  assert.equal(sig1.length, 12);
});

test("computeSignature varies by file", () => {
  const sig1 = computeSignature("a.spec.ts", ["test"], "error");
  const sig2 = computeSignature("b.spec.ts", ["test"], "error");
  assert.notEqual(sig1, sig2);
});

test("computeSignature varies by title path", () => {
  const sig1 = computeSignature("x.spec.ts", ["A", "B"], "error");
  const sig2 = computeSignature("x.spec.ts", ["A", "C"], "error");
  assert.notEqual(sig1, sig2);
});

test("computeSignature normalizes error before hashing", () => {
  const sig1 = computeSignature("spec.ts", ["test"], "Error at /Users/alice/code.ts:10:5");
  const sig2 = computeSignature("spec.ts", ["test"], "Error at /home/bob/code.ts:20:15");
  assert.equal(sig1, sig2);
});

test("extractFailures returns empty for null/undefined", () => {
  assert.deepEqual(extractFailures(null), []);
  assert.deepEqual(extractFailures({}), []);
  assert.deepEqual(extractFailures({ suites: [] }), []);
});

test("extractFailures extracts failing tests", () => {
  const report = {
    suites: [
      {
        file: "e2e/core/test.spec.ts",
        title: "root",
        specs: [
          {
            title: "should work",
            tests: [
              {
                projectName: "core",
                results: [
                  {
                    status: "failed",
                    errors: [{ message: "AssertionError: expected 1 got 2", stack: "at ..." }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const failures = extractFailures(report);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].file, "e2e/core/test.spec.ts");
  assert.deepEqual(failures[0].titlePath, ["root", "should work"]);
  assert.equal(failures[0].projectName, "core");
  assert.equal(failures[0].status, "failed");
  assert.ok(failures[0].signature);
});

test("extractFailures skips passed and skipped tests", () => {
  const report = {
    suites: [
      {
        file: "spec.ts",
        title: "root",
        specs: [
          {
            title: "passes",
            tests: [{ projectName: "core", results: [{ status: "passed", errors: [] }] }],
          },
          {
            title: "skipped",
            tests: [{ projectName: "core", results: [{ status: "skipped", errors: [] }] }],
          },
          {
            title: "fails",
            tests: [
              {
                projectName: "core",
                results: [{ status: "failed", errors: [{ message: "boom" }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const failures = extractFailures(report);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].titlePath[1], "fails");
});

test("extractFailures walks nested suites", () => {
  const report = {
    suites: [
      {
        file: "spec.ts",
        title: "root",
        suites: [
          {
            title: "Feature X",
            specs: [
              {
                title: "scenario A",
                tests: [
                  {
                    projectName: "full-terminal",
                    results: [{ status: "failed", errors: [{ message: "timeout" }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const failures = extractFailures(report);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].titlePath, ["root", "Feature X", "scenario A"]);
});

test("extractFailures handles missing errors gracefully", () => {
  const report = {
    suites: [
      {
        file: "spec.ts",
        title: "root",
        specs: [
          {
            title: "fails",
            tests: [
              {
                projectName: "core",
                results: [{ status: "failed", errors: [] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const failures = extractFailures(report);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorMessage, "Unknown error");
});

test("extractFailures handles retries (multiple results per test)", () => {
  const report = {
    suites: [
      {
        file: "spec.ts",
        title: "root",
        specs: [
          {
            title: "flaky",
            tests: [
              {
                projectName: "core",
                results: [
                  { status: "failed", errors: [{ message: "first fail" }] },
                  { status: "failed", errors: [{ message: "second fail" }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const failures = extractFailures(report);
  assert.equal(failures.length, 2);
});

test("extractFailures handles multi-project reports", () => {
  const report = {
    suites: [
      {
        file: "spec.ts",
        title: "root",
        specs: [
          {
            title: "test",
            tests: [
              {
                projectName: "core",
                results: [{ status: "failed", errors: [{ message: "err" }] }],
              },
              {
                projectName: "full-terminal",
                results: [{ status: "failed", errors: [{ message: "err" }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const failures = extractFailures(report);
  assert.equal(failures.length, 2);
  assert.equal(failures[0].projectName, "core");
  assert.equal(failures[1].projectName, "full-terminal");
});
