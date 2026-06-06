import { describe, it, expect } from "vitest";
import { computeSignature, extractFailures, normalizeError } from "./extract-failures.mjs";

it("normalizeError strips paths", () => {
  const input = "Error at /Users/test/project/src/file.ts:42:10";
  const result = normalizeError(input);
  expect(result).not.toContain("/Users/test/project");
  expect(result).toContain("<path>");
});

it("normalizeError strips timestamps", () => {
  const input = "Failed at 2025-06-15T03:00:00.123Z";
  const result = normalizeError(input);
  expect(result).not.toContain("2025-06-15");
  expect(result).toContain("<timestamp>");
});

it("normalizeError strips line:col", () => {
  const input = "Error at file.ts:42:10 and also file.ts:100:5";
  const result = normalizeError(input);
  expect(result).not.toContain(":42:10");
  expect(result).not.toContain(":100:5");
  expect(result).toContain(":<line>:<col>");
});

it("normalizeError strips memory addresses", () => {
  const input = "Segfault at 0x7fff5fbff000 and 0xDEADBEEF1234";
  const result = normalizeError(input);
  expect(result).not.toContain("0x7fff5fbff000");
  expect(result).not.toContain("0xDEADBEEF1234");
  expect(result).toContain("0x<addr>");
});

it("normalizeError strips UUIDs", () => {
  const input = "Session abc123de-4567-8901-abcd-ef1234567890 not found";
  const result = normalizeError(input);
  expect(result).not.toContain("abc123de-4567-8901-abcd-ef1234567890");
  expect(result).toContain("<uuid>");
});

it("normalizeError strips ports", () => {
  const input = "Connection refused on localhost:9222";
  const result = normalizeError(input);
  expect(result).not.toContain(":9222");
});

it("computeSignature is deterministic", () => {
  const sig1 = computeSignature("spec.ts", ["suite", "test name"], "Error: things broke");
  const sig2 = computeSignature("spec.ts", ["suite", "test name"], "Error: things broke");
  expect(sig1).toBe(sig2);
  expect(sig1.length).toBe(12);
});

it("computeSignature varies by file", () => {
  const sig1 = computeSignature("a.spec.ts", ["test"], "error");
  const sig2 = computeSignature("b.spec.ts", ["test"], "error");
  expect(sig1).not.toBe(sig2);
});

it("computeSignature varies by title path", () => {
  const sig1 = computeSignature("x.spec.ts", ["A", "B"], "error");
  const sig2 = computeSignature("x.spec.ts", ["A", "C"], "error");
  expect(sig1).not.toBe(sig2);
});

it("computeSignature normalizes error before hashing", () => {
  const sig1 = computeSignature("spec.ts", ["test"], "Error at /Users/alice/code.ts:10:5");
  const sig2 = computeSignature("spec.ts", ["test"], "Error at /home/bob/code.ts:20:15");
  expect(sig1).toBe(sig2);
});

it("extractFailures returns empty for null/undefined", () => {
  expect(extractFailures(null)).toEqual([]);
  expect(extractFailures({})).toEqual([]);
  expect(extractFailures({ suites: [] })).toEqual([]);
});

it("extractFailures extracts failing tests", () => {
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
                status: "unexpected",
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
  expect(failures.length).toBe(1);
  expect(failures[0].file).toBe("e2e/core/test.spec.ts");
  expect(failures[0].titlePath).toEqual(["root", "should work"]);
  expect(failures[0].projectName).toBe("core");
  expect(failures[0].status).toBe("failed");
  expect(failures[0].signature).toBeTruthy();
});

it("extractFailures skips passed and skipped tests", () => {
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
  expect(failures.length).toBe(1);
  expect(failures[0].titlePath[1]).toBe("fails");
});

it("extractFailures walks nested suites", () => {
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
  expect(failures.length).toBe(1);
  expect(failures[0].titlePath).toEqual(["root", "Feature X", "scenario A"]);
});

it("extractFailures handles missing errors gracefully", () => {
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
  expect(failures.length).toBe(1);
  expect(failures[0].errorMessage).toBe("Unknown error");
});

it("extractFailures emits one failure for a test that failed every retry", () => {
  const report = {
    suites: [
      {
        file: "spec.ts",
        title: "root",
        specs: [
          {
            title: "broken",
            tests: [
              {
                projectName: "core",
                status: "unexpected",
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
  expect(failures.length).toBe(1);
  expect(failures[0].errorMessage).toBe("second fail");
});

it("extractFailures skips recovered flakes (failed then passed on retry)", () => {
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
                status: "flaky",
                results: [
                  { status: "failed", errors: [{ message: "transient" }] },
                  { status: "passed", errors: [] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  expect(extractFailures(report)).toEqual([]);
});

it("extractFailures falls back to last result when test status is absent", () => {
  const failing = {
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
  const failures = extractFailures(failing);
  expect(failures.length).toBe(1);
  expect(failures[0].errorMessage).toBe("second fail");

  const recovered = {
    suites: [
      {
        file: "spec.ts",
        title: "root",
        specs: [
          {
            title: "recovers",
            tests: [
              {
                projectName: "core",
                results: [
                  { status: "failed", errors: [{ message: "transient" }] },
                  { status: "passed", errors: [] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  expect(extractFailures(recovered)).toEqual([]);
});

it("extractFailures handles unexpected status with no results", () => {
  const report = {
    suites: [
      {
        file: "spec.ts",
        title: "root",
        specs: [
          {
            title: "interrupted",
            tests: [{ projectName: "core", status: "unexpected", results: [] }],
          },
        ],
      },
    ],
  };
  const failures = extractFailures(report);
  expect(failures.length).toBe(1);
  expect(failures[0].status).toBe("failed");
  expect(failures[0].errorMessage).toBe("Unknown error");
});

it("extractFailures handles multi-project reports", () => {
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
  expect(failures.length).toBe(2);
  expect(failures[0].projectName).toBe("core");
  expect(failures[1].projectName).toBe("full-terminal");
});

it("extractFailures propagates file to nested describe suites", () => {
  const report = {
    suites: [
      {
        file: "e2e/core/login.spec.ts",
        title: "root",
        suites: [
          {
            title: "Login page",
            specs: [
              {
                title: "should reject invalid password",
                tests: [
                  {
                    projectName: "core",
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
  expect(failures.length).toBe(1);
  expect(failures[0].file).toBe("e2e/core/login.spec.ts");
  expect(failures[0].titlePath).toEqual(["root", "Login page", "should reject invalid password"]);

  // Same nested structure, different file → different signature
  const report2 = { suites: [{ ...report.suites[0], file: "e2e/core/signup.spec.ts" }] };
  const failures2 = extractFailures(report2);
  expect(failures2.length).toBe(1);
  expect(failures2[0].file).toBe("e2e/core/signup.spec.ts");
  expect(failures[0].signature).not.toBe(failures2[0].signature);
});

it("normalizeError normalizes Windows paths", () => {
  const posixErr = "Error at /Users/runner/work/repo/e2e/test.spec.ts:42";
  const winErr = "Error at C:\\Users\\runneradmin\\work\\repo\\e2e\\test.spec.ts:42";
  expect(normalizeError(winErr)).toBe(normalizeError(posixErr));
});

it("computeSignature matches across OS path flavors", () => {
  const sig1 = computeSignature(
    "e2e/test.spec.ts",
    ["suite", "test"],
    "Error at /Users/runner/work/repo/e2e/test.spec.ts:42:10"
  );
  const sig2 = computeSignature(
    "e2e/test.spec.ts",
    ["suite", "test"],
    "Error at C:\\Users\\runneradmin\\work\\repo\\e2e\\test.spec.ts:42:10"
  );
  expect(sig1).toBe(sig2);
});
