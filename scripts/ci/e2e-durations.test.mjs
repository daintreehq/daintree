import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseArgs, reportPlatform, summarizeReports } from "./e2e-durations.mjs";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "__fixtures__", "e2e-durations-report.json"), "utf8")
);

describe("summarizeReports", () => {
  it("sums final-attempt durations per spec file and counts retries separately", () => {
    const { specs } = summarizeReports([{ report: fixture, platform: "linux" }]);
    expect(specs).toEqual([
      {
        platform: "linux",
        project: "core",
        file: "core/a.spec.ts",
        tests: 3,
        durationMs: 1000,
        durationWithRetriesMs: 1000,
        retries: 0,
        status: { passed: 2, failed: 0, flaky: 0, skipped: 1 },
      },
      {
        platform: "linux",
        project: "full-terminal",
        file: "full/terminal/b.spec.ts",
        tests: 2,
        durationMs: 31200,
        durationWithRetriesMs: 66200,
        retries: 2,
        status: { passed: 0, failed: 1, flaky: 1, skipped: 0 },
      },
    ]);
  });

  it("rolls specs up into per-project totals", () => {
    const { projects, platforms } = summarizeReports([{ report: fixture, platform: "linux" }]);
    expect(platforms).toEqual(["linux"]);
    expect(projects).toEqual([
      {
        platform: "linux",
        project: "core",
        specs: 1,
        tests: 3,
        durationMs: 1000,
        durationWithRetriesMs: 1000,
        retries: 0,
        status: { passed: 2, failed: 0, flaky: 0, skipped: 1 },
      },
      {
        platform: "linux",
        project: "full-terminal",
        specs: 1,
        tests: 2,
        durationMs: 31200,
        durationWithRetriesMs: 66200,
        retries: 2,
        status: { passed: 0, failed: 1, flaky: 1, skipped: 0 },
      },
    ]);
  });

  it("merges shards of the same platform and keeps platforms apart", () => {
    const summary = summarizeReports([
      { report: fixture, platform: "linux" },
      { report: fixture, platform: "linux" },
      { report: fixture, platform: "win32" },
    ]);
    expect(summary.platforms).toEqual(["linux", "win32"]);
    const linuxCore = summary.specs.find((s) => s.platform === "linux" && s.project === "core");
    expect(linuxCore.tests).toBe(6);
    expect(linuxCore.durationMs).toBe(2000);
    expect(summary.specs).toHaveLength(4);
  });

  it("is deterministic regardless of report order", () => {
    const a = summarizeReports([
      { report: fixture, platform: "win32" },
      { report: fixture, platform: "linux" },
    ]);
    const b = summarizeReports([
      { report: fixture, platform: "linux" },
      { report: fixture, platform: "win32" },
    ]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("attributes helper-declared tests to the runnable spec, not the helper", () => {
    const helperSuite = (spec) => ({
      title: spec,
      file: spec,
      specs: [],
      suites: [
        {
          title: "shared helper block",
          file: "helpers/shared.ts",
          specs: [
            {
              title: "declared in helper",
              file: "helpers/shared.ts",
              tests: [
                {
                  projectName: "p",
                  status: "expected",
                  results: [{ status: "passed", duration: 100 }],
                },
              ],
            },
          ],
        },
      ],
    });
    const report = { suites: [helperSuite("a.spec.ts"), helperSuite("b.spec.ts")] };
    const { specs } = summarizeReports([{ report }]);
    expect(specs.map((s) => [s.file, s.tests, s.durationMs])).toEqual([
      ["a.spec.ts", 1, 100],
      ["b.spec.ts", 1, 100],
    ]);
  });

  it("infers outcome from the last attempt when the test status is absent", () => {
    const report = {
      suites: [
        {
          file: "x.spec.ts",
          specs: [
            {
              tests: [
                { projectName: "p", results: [{ status: "passed", duration: 10 }] },
                { projectName: "p", results: [{ status: "timedOut", duration: 20 }] },
                { projectName: "p", results: [] },
              ],
            },
          ],
        },
      ],
    };
    const [spec] = summarizeReports([{ report }]).specs;
    expect(spec.platform).toBeNull();
    expect(spec.status).toEqual({ passed: 1, failed: 1, flaky: 0, skipped: 1 });
    expect(spec.durationMs).toBe(30);
  });

  it("returns empty collections for a report without suites", () => {
    expect(summarizeReports([{ report: {} }])).toEqual({ platforms: [], projects: [], specs: [] });
  });
});

describe("reportPlatform", () => {
  it("prefers report metadata over the fallback", () => {
    expect(reportPlatform({ config: { metadata: { platform: "darwin" } } }, "linux")).toBe(
      "darwin"
    );
    expect(reportPlatform(fixture, "linux")).toBe("linux");
    expect(reportPlatform(fixture)).toBeNull();
  });
});

describe("parseArgs", () => {
  it("parses inputs, --out and --platform", () => {
    expect(parseArgs(["a.json", "--out", "o.json", "--platform", "linux", "b.json"])).toEqual({
      platform: "linux",
      out: "o.json",
      inputs: ["a.json", "b.json"],
    });
  });

  it("rejects unknown options and missing values", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--out"])).toThrow(/needs a value/);
  });
});
