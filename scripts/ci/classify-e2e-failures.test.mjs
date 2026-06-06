import { describe, it, expect } from "vitest";
import { classifyError, extractFailures, buildClassification } from "./classify-e2e-failures.mjs";

describe("classifyError", () => {
  it("classifies spawn EPERM as Infrastructure", () => {
    const result = classifyError("spawn EPERM: operation not permitted");
    expect(result.bucket).toBe("Infrastructure");
    expect(result.label).toContain("EPERM");
  });

  it("classifies EBUSY on .tmp as Infrastructure", () => {
    const result = classifyError("EBUSY: resource busy or locked, rename '/tmp/foo.tmp'");
    expect(result.bucket).toBe("Infrastructure");
    expect(result.label).toContain("EBUSY");
  });

  it("classifies bare EPERM as Infrastructure", () => {
    const result = classifyError("EPERM: operation not permitted, open '/some/file'");
    expect(result.bucket).toBe("Infrastructure");
  });

  it("classifies EACCES as Infrastructure", () => {
    const result = classifyError("EACCES: permission denied, access '/foo'");
    expect(result.bucket).toBe("Infrastructure");
  });

  it("classifies ENOSPC as Infrastructure", () => {
    const result = classifyError("ENOSPC: no space left on device");
    expect(result.bucket).toBe("Infrastructure");
  });

  it("classifies CDP target not found as Test-Logic", () => {
    const result = classifyError("CDP target not found: page has been closed");
    expect(result.bucket).toBe("Test-Logic");
    expect(result.label).toContain("CDP");
  });

  it("classifies Target.targetCreated timeout as Test-Logic", () => {
    const result = classifyError("Target.targetCreated: timeout 30000ms exceeded");
    expect(result.bucket).toBe("Test-Logic");
    expect(result.label).toContain("handshake");
  });

  it("classifies Target closed as Test-Logic", () => {
    const result = classifyError("Target has been closed after navigation");
    expect(result.bucket).toBe("Test-Logic");
  });

  it("classifies Browser closed as Test-Logic", () => {
    const result = classifyError("Browser has been closed unexpectedly");
    expect(result.bucket).toBe("Test-Logic");
  });

  it("classifies page closed as Test-Logic", () => {
    const result = classifyError("page has been closed");
    expect(result.bucket).toBe("Test-Logic");
  });

  it("classifies selector timeout as Test-Logic", () => {
    const result = classifyError("waiting for selector '.missing-element' timed out after 30000ms");
    expect(result.bucket).toBe("Test-Logic");
  });

  it("classifies test timeout as Test-Logic", () => {
    const result = classifyError("Test timeout of 120000ms exceeded.");
    expect(result.bucket).toBe("Test-Logic");
  });

  it("classifies WebContents crashed as Product-Logic", () => {
    const result = classifyError("WebContents crashed with exit code 139");
    expect(result.bucket).toBe("Product-Logic");
    expect(result.label).toContain("WebContents");
  });

  it("classifies renderer process crash as Product-Logic", () => {
    const result = classifyError("renderer process crashed with signal SIGSEGV");
    expect(result.bucket).toBe("Product-Logic");
  });

  it("classifies GPU process crash as Product-Logic", () => {
    const result = classifyError("GPU process crash detected");
    expect(result.bucket).toBe("Product-Logic");
  });

  it("classifies unknown errors as Unclassified", () => {
    const result = classifyError("something completely unexpected happened");
    expect(result.bucket).toBe("Unclassified");
  });

  it("handles empty error text", () => {
    const result = classifyError(null);
    expect(result.bucket).toBe("Unclassified");
    expect(result.label).toBe("empty error");
  });

  it("handles undefined error text", () => {
    const result = classifyError(undefined);
    expect(result.bucket).toBe("Unclassified");
  });

  it("matches spawn EPERM before bare EPERM (specific before broad)", () => {
    const result = classifyError("spawn EPERM: operation not permitted");
    expect(result.bucket).toBe("Infrastructure");
    // Should match the "spawn EPERM (AV on-access scan)" label, not "EPERM (permission denied)"
    expect(result.label).toContain("AV on-access scan");
  });

  it("matches EBUSY on .tmp before any broader match", () => {
    const result = classifyError("EBUSY: resource busy or locked, rename '/tmp/foo.tmp'");
    expect(result.bucket).toBe("Infrastructure");
    expect(result.label).toContain("indexer contention");
  });

  it("classifies Playwright 'Page crashed' as Product-Logic", () => {
    const result = classifyError("page.goto: Page crashed");
    expect(result.bucket).toBe("Product-Logic");
  });

  it("classifies navigation crash as Product-Logic", () => {
    const result = classifyError("Navigation failed because page crashed!");
    expect(result.bucket).toBe("Product-Logic");
  });

  it("classifies Target crashed as Product-Logic", () => {
    const result = classifyError("locator.click: Target crashed");
    expect(result.bucket).toBe("Product-Logic");
  });

  it("routes a crash to Product-Logic even when stale-ref text is also present", () => {
    // A crash often drags stale-ref noise along; the crash must win.
    const result = classifyError("page.goto: Page crashed\npage has been closed");
    expect(result.bucket).toBe("Product-Logic");
  });

  it("keeps plain 'Page has been closed.' in Test-Logic (not a crash)", () => {
    const result = classifyError("Page has been closed.");
    expect(result.bucket).toBe("Test-Logic");
  });

  it("classifies Playwright worker death as Infrastructure", () => {
    const result = classifyError("Error: worker process exited unexpectedly (code=1, signal=null)");
    expect(result.bucket).toBe("Infrastructure");
  });
});

describe("extractFailures", () => {
  it("returns empty array for empty report", () => {
    expect(extractFailures({})).toEqual([]);
  });

  it("returns empty array when all tests passed", () => {
    const report = {
      suites: [
        {
          title: "test.spec.ts",
          specs: [
            {
              title: "my test",
              tests: [
                {
                  projectName: "core",
                  results: [{ status: "passed" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(extractFailures(report)).toEqual([]);
  });

  it("extracts a single failure with file and line", () => {
    const report = {
      suites: [
        {
          title: "test.spec.ts",
          file: "/app/e2e/core/test.spec.ts",
          specs: [
            {
              title: "should work",
              file: "/app/e2e/core/test.spec.ts",
              line: 42,
              tests: [
                {
                  projectName: "core",
                  results: [
                    {
                      status: "failed",
                      error: {
                        message: "spawn EPERM: operation not permitted",
                        stack: "Error: spawn EPERM\n    at foo (test.spec.ts:42:5)",
                        location: { file: "/app/e2e/core/test.spec.ts", line: 42, column: 5 },
                      },
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
    expect(failures).toHaveLength(1);
    expect(failures[0].file).toContain("test.spec.ts");
    expect(failures[0].line).toBe(42);
    expect(failures[0].bucket).toBe("Infrastructure");
    expect(failures[0].attempts).toBe(1);
  });

  it("deduplicates by file:line + title", () => {
    const report = {
      suites: [
        {
          specs: [
            {
              title: "flaky test",
              file: "/app/test.spec.ts",
              line: 10,
              tests: [
                {
                  projectName: "core",
                  results: [
                    {
                      status: "failed",
                      error: { message: "boom", location: { file: "/app/test.spec.ts", line: 10 } },
                    },
                    {
                      status: "failed",
                      error: {
                        message: "boom again",
                        location: { file: "/app/test.spec.ts", line: 10 },
                      },
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
    expect(failures).toHaveLength(1); // deduped to 1 unique
    expect(failures[0].attempts).toBe(2); // 2 retry results
  });

  it("distinguishes different tests on same line", () => {
    const report = {
      suites: [
        {
          specs: [
            {
              title: "test A",
              file: "/app/test.spec.ts",
              line: 10,
              tests: [
                {
                  projectName: "core",
                  results: [
                    {
                      status: "failed",
                      error: { message: "err", location: { file: "/app/test.spec.ts", line: 10 } },
                    },
                  ],
                },
              ],
            },
            {
              title: "test B",
              file: "/app/test.spec.ts",
              line: 10,
              tests: [
                {
                  projectName: "core",
                  results: [
                    {
                      status: "failed",
                      error: { message: "err", location: { file: "/app/test.spec.ts", line: 10 } },
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
    // Different titles = different dedup keys
    expect(failures).toHaveLength(2);
  });

  it("handles timedOut status", () => {
    const report = {
      suites: [
        {
          specs: [
            {
              title: "slow test",
              tests: [
                {
                  projectName: "full-terminal",
                  results: [
                    {
                      status: "timedOut",
                      error: { message: "Test timeout of 120000ms exceeded." },
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
    expect(failures).toHaveLength(1);
    expect(failures[0].bucket).toBe("Test-Logic");
  });

  it("handles nested suites (describe blocks)", () => {
    const report = {
      suites: [
        {
          title: "outer.spec.ts",
          suites: [
            {
              title: "describe block",
              specs: [
                {
                  title: "inner test",
                  tests: [
                    {
                      projectName: "core",
                      results: [{ status: "failed", error: { message: "WebContents crashed" } }],
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
    expect(failures).toHaveLength(1);
    expect(failures[0].bucket).toBe("Product-Logic");
  });

  it("includes interrupted results with an error", () => {
    const report = {
      suites: [
        {
          specs: [
            {
              title: "crashed mid-run",
              tests: [
                {
                  projectName: "core",
                  results: [
                    {
                      status: "interrupted",
                      error: { message: "page.goto: Page crashed" },
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
    expect(failures).toHaveLength(1);
    expect(failures[0].bucket).toBe("Product-Logic");
  });

  it("includes interrupted results without an error as Unclassified", () => {
    const report = {
      suites: [
        {
          specs: [
            {
              title: "cancelled test",
              tests: [
                {
                  projectName: "core",
                  results: [{ status: "interrupted" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const failures = extractFailures(report);
    expect(failures).toHaveLength(1);
    expect(failures[0].bucket).toBe("Unclassified");
  });

  it("handles multiple errors in result.errors array", () => {
    const report = {
      suites: [
        {
          specs: [
            {
              title: "multi-error test",
              tests: [
                {
                  projectName: "core",
                  results: [
                    {
                      status: "failed",
                      errors: [{ message: "GPU process crash" }, { message: "secondary error" }],
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
    expect(failures).toHaveLength(1);
    expect(failures[0].bucket).toBe("Product-Logic");
  });
});

describe("buildClassification", () => {
  it("builds summary from failures", () => {
    const failures = [
      {
        file: "a.ts",
        line: 1,
        title: "infra",
        project: "core",
        bucket: "Infrastructure",
        label: "spawn EPERM",
        attempts: 3,
        firstError: "spawn EPERM",
      },
      {
        file: "b.ts",
        line: 2,
        title: "product",
        project: "full-terminal",
        bucket: "Product-Logic",
        label: "WebContents crashed",
        attempts: 1,
        firstError: "crashed",
      },
    ];
    const classification = buildClassification(failures);
    expect(classification.totalUnique).toBe(2);
    expect(classification.totalAttempts).toBe(4);
    expect(classification.buckets.Infrastructure.unique).toBe(1);
    expect(classification.buckets.Infrastructure.attempts).toBe(3);
    expect(classification.buckets["Product-Logic"].unique).toBe(1);
    expect(classification.buckets["Product-Logic"].attempts).toBe(1);
    expect(classification.buckets["Test-Logic"]).toBeUndefined();
    expect(classification.buckets.Unclassified).toBeUndefined();
  });

  it("caps top failures at 5 per bucket", () => {
    const failures = [];
    for (let i = 0; i < 10; i++) {
      failures.push({
        file: `test${i}.ts`,
        line: i,
        title: `test ${i}`,
        project: "core",
        bucket: "Infrastructure",
        label: "EPERM",
        attempts: 1,
        firstError: "err",
      });
    }
    const classification = buildClassification(failures);
    expect(classification.buckets.Infrastructure.unique).toBe(10);
    expect(classification.buckets.Infrastructure.top).toHaveLength(5);
  });

  it("returns empty summary for no failures", () => {
    const classification = buildClassification([]);
    expect(classification.totalUnique).toBe(0);
    expect(classification.totalAttempts).toBe(0);
    expect(Object.keys(classification.buckets)).toHaveLength(0);
  });
});
