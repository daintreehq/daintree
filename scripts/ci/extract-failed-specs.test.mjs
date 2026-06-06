import { describe, it, expect } from "vitest";
import { extractFailedSpecPaths } from "./extract-failed-specs.mjs";

function spec(file, status, lastResultStatus) {
  return {
    file,
    title: `${file} test`,
    tests: [
      {
        status,
        results: [{ status: lastResultStatus }],
      },
    ],
  };
}

describe("extractFailedSpecPaths", () => {
  it("returns empty for null/empty reports", () => {
    expect(extractFailedSpecPaths(null)).toEqual([]);
    expect(extractFailedSpecPaths({})).toEqual([]);
    expect(extractFailedSpecPaths({ suites: [] })).toEqual([]);
  });

  it("includes hard-failed specs", () => {
    const report = {
      suites: [{ specs: [spec("e2e/core/a.spec.ts", "unexpected", "failed")] }],
    };
    expect(extractFailedSpecPaths(report)).toEqual(["e2e/core/a.spec.ts"]);
  });

  it("includes flaky specs even though spec-level ok is true", () => {
    // Flaky = failed first attempt, passed on retry. The last result is
    // "passed" and spec.ok would be true, but FAIL_ON_FLAKY_TESTS makes it a
    // gate failure — so it MUST land in the retry list. This is the #10039 bug.
    const report = {
      suites: [
        {
          specs: [
            {
              file: "e2e/core/flaky.spec.ts",
              tests: [{ status: "flaky", results: [{ status: "failed" }, { status: "passed" }] }],
            },
          ],
        },
      ],
    };
    expect(extractFailedSpecPaths(report)).toEqual(["e2e/core/flaky.spec.ts"]);
  });

  it("includes both hard-failed and flaky specs, sorted and deduped", () => {
    const report = {
      suites: [
        {
          specs: [
            spec("e2e/core/hard.spec.ts", "unexpected", "failed"),
            {
              file: "e2e/core/flaky.spec.ts",
              tests: [{ status: "flaky", results: [{ status: "passed" }] }],
            },
            // Duplicate file path across two specs in the same file — deduped.
            spec("e2e/core/hard.spec.ts", "unexpected", "timedOut"),
          ],
        },
      ],
    };
    expect(extractFailedSpecPaths(report)).toEqual([
      "e2e/core/flaky.spec.ts",
      "e2e/core/hard.spec.ts",
    ]);
  });

  it("excludes passed and skipped specs", () => {
    const report = {
      suites: [
        {
          specs: [
            spec("e2e/core/pass.spec.ts", "expected", "passed"),
            spec("e2e/core/skip.spec.ts", "skipped", "skipped"),
          ],
        },
      ],
    };
    expect(extractFailedSpecPaths(report)).toEqual([]);
  });

  it("treats timedOut and interrupted last results as failures", () => {
    const report = {
      suites: [
        {
          specs: [
            spec("e2e/core/timeout.spec.ts", "unexpected", "timedOut"),
            spec("e2e/core/interrupted.spec.ts", "unexpected", "interrupted"),
          ],
        },
      ],
    };
    expect(extractFailedSpecPaths(report)).toEqual([
      "e2e/core/interrupted.spec.ts",
      "e2e/core/timeout.spec.ts",
    ]);
  });

  it("walks nested describe suites and propagates the spec file", () => {
    const report = {
      suites: [
        {
          title: "root",
          suites: [
            {
              title: "Feature X",
              specs: [spec("e2e/full/nested.spec.ts", "unexpected", "failed")],
            },
          ],
        },
      ],
    };
    expect(extractFailedSpecPaths(report)).toEqual(["e2e/full/nested.spec.ts"]);
  });

  it("ignores specs without a file path", () => {
    const report = {
      suites: [{ specs: [{ tests: [{ status: "unexpected", results: [{ status: "failed" }] }] }] }],
    };
    expect(extractFailedSpecPaths(report)).toEqual([]);
  });

  it("handles specs with missing tests array", () => {
    const report = {
      suites: [{ specs: [{ file: "e2e/core/empty.spec.ts" }] }],
    };
    expect(extractFailedSpecPaths(report)).toEqual([]);
  });

  it("returns [] for a non-array suites shape rather than throwing", () => {
    expect(extractFailedSpecPaths({ suites: null })).toEqual([]);
    expect(extractFailedSpecPaths({ suites: 42 })).toEqual([]);
    expect(() => extractFailedSpecPaths({ suites: { not: "an array" } })).not.toThrow();
    expect(extractFailedSpecPaths({ suites: { not: "an array" } })).toEqual([]);
  });

  it("includes a spec when any of its tests failed (any-failure semantics)", () => {
    const report = {
      suites: [
        {
          specs: [
            {
              file: "e2e/core/multi.spec.ts",
              tests: [
                { status: "expected", results: [{ status: "passed" }] },
                { status: "unexpected", results: [{ status: "failed" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(extractFailedSpecPaths(report)).toEqual(["e2e/core/multi.spec.ts"]);
  });

  it("excludes a test with an empty results array and a non-flaky status", () => {
    // Playwright always populates results for a test that ran; an empty results
    // array means nothing ran, so there is no last-result failure to report and
    // the spec is intentionally excluded (matches the manifest-step predicate).
    const report = {
      suites: [{ specs: [{ file: "e2e/core/noresult.spec.ts", tests: [{ results: [] }] }] }],
    };
    expect(extractFailedSpecPaths(report)).toEqual([]);
  });
});
