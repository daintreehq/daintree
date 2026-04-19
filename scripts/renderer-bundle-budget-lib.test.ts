import { describe, it, expect } from "vitest";
import { compareReports, formatMarkdown, validateReport } from "./renderer-bundle-budget-lib.mjs";

const makeReport = (overrides = {}) => ({
  entryChunk: "main",
  chunks: {
    main: { raw: 500_000, gzip: 120_000 },
    vendor: { raw: 800_000, gzip: 250_000 },
    "vendor-xterm": { raw: 300_000, gzip: 90_000 },
  },
  totals: {
    js: { raw: 1_600_000, gzip: 460_000 },
    css: { raw: 200_000, gzip: 40_000 },
  },
  ...overrides,
});

describe("validateReport", () => {
  it("accepts a valid report", () => {
    expect(validateReport(makeReport())).toEqual([]);
  });

  it("accepts entryChunk null", () => {
    const r = makeReport({ entryChunk: null });
    expect(validateReport(r)).toEqual([]);
  });

  it("rejects non-object", () => {
    expect(validateReport(null).length).toBeGreaterThan(0);
    expect(validateReport("x").length).toBeGreaterThan(0);
  });

  it("rejects missing chunks", () => {
    const r = makeReport();
    delete r.chunks;
    expect(validateReport(r)).toContain("`chunks` must be an object");
  });

  it("rejects invalid chunk entry", () => {
    const r = makeReport({ chunks: { main: { raw: "bad", gzip: 1 } } });
    expect(validateReport(r).length).toBeGreaterThan(0);
  });

  it("rejects missing totals", () => {
    const r = makeReport();
    delete r.totals;
    expect(validateReport(r)).toContain("`totals` must be an object");
  });

  it("rejects invalid totals subfield", () => {
    const r = makeReport({ totals: { js: { raw: 1 }, css: { raw: 1, gzip: 1 } } });
    expect(validateReport(r).some((e) => e.includes("totals.js"))).toBe(true);
  });
});

describe("compareReports", () => {
  const baseline = makeReport();

  it("passes when current matches baseline", () => {
    const result = compareReports(makeReport(), baseline, 0.05);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("passes when current is smaller", () => {
    const current = makeReport({
      chunks: {
        main: { raw: 400_000, gzip: 100_000 },
        vendor: { raw: 800_000, gzip: 250_000 },
        "vendor-xterm": { raw: 300_000, gzip: 90_000 },
      },
      totals: { js: { raw: 1_500_000, gzip: 440_000 }, css: { raw: 200_000, gzip: 40_000 } },
    });
    const result = compareReports(current, baseline, 0.05);
    expect(result.ok).toBe(true);
    expect(result.improvements.length).toBeGreaterThan(0);
  });

  it("fails when entry chunk gzip exceeds threshold", () => {
    const current = makeReport({
      chunks: {
        main: { raw: 500_000, gzip: 127_000 },
        vendor: { raw: 800_000, gzip: 250_000 },
        "vendor-xterm": { raw: 300_000, gzip: 90_000 },
      },
      totals: { js: { raw: 1_600_000, gzip: 467_000 }, css: { raw: 200_000, gzip: 40_000 } },
    });
    const result = compareReports(current, baseline, 0.05);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.metric.includes("entry chunk gzip"))).toBe(true);
  });

  it("fails when total JS gzip exceeds threshold", () => {
    const current = makeReport({
      totals: { js: { raw: 1_700_000, gzip: 490_000 }, css: { raw: 200_000, gzip: 40_000 } },
    });
    const result = compareReports(current, baseline, 0.05);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.metric === "total JS gzip")).toBe(true);
  });

  it("fails when total CSS gzip exceeds threshold", () => {
    const current = makeReport({
      totals: { js: { raw: 1_600_000, gzip: 460_000 }, css: { raw: 250_000, gzip: 43_000 } },
    });
    const result = compareReports(current, baseline, 0.05);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.metric === "total CSS gzip")).toBe(true);
  });

  it("passes at exact threshold boundary (5.00%)", () => {
    const entryGzip = 120_000 * 1.05;
    const current = makeReport({
      chunks: {
        main: { raw: 500_000, gzip: entryGzip },
        vendor: { raw: 800_000, gzip: 250_000 },
        "vendor-xterm": { raw: 300_000, gzip: 90_000 },
      },
      totals: {
        js: { raw: 1_600_000, gzip: 250_000 + 90_000 + entryGzip },
        css: { raw: 200_000, gzip: 40_000 },
      },
    });
    const result = compareReports(current, baseline, 0.05);
    expect(result.ok).toBe(true);
  });

  it("fails just above threshold (5.01%)", () => {
    const entryGzip = Math.floor(120_000 * 1.0501);
    const current = makeReport({
      chunks: {
        main: { raw: 500_000, gzip: entryGzip },
        vendor: { raw: 800_000, gzip: 250_000 },
        "vendor-xterm": { raw: 300_000, gzip: 90_000 },
      },
      totals: {
        js: { raw: 1_600_000, gzip: 250_000 + 90_000 + entryGzip },
        css: { raw: 200_000, gzip: 40_000 },
      },
    });
    const result = compareReports(current, baseline, 0.05);
    expect(result.ok).toBe(false);
  });

  it("handles new chunk not in baseline", () => {
    const current = makeReport({
      chunks: {
        main: { raw: 500_000, gzip: 120_000 },
        vendor: { raw: 800_000, gzip: 250_000 },
        "vendor-xterm": { raw: 300_000, gzip: 90_000 },
        "vendor-new": { raw: 100_000, gzip: 30_000 },
      },
      totals: { js: { raw: 1_700_000, gzip: 490_000 }, css: { raw: 200_000, gzip: 40_000 } },
    });
    const result = compareReports(current, baseline, 0.05);
    expect(result.ok).toBe(false);
    expect(result.chunkDeltas.some((d) => d.name === "vendor-new" && d.baseline === 0)).toBe(true);
  });

  it("handles chunk removed from baseline", () => {
    const current = makeReport({
      chunks: {
        main: { raw: 500_000, gzip: 120_000 },
        vendor: { raw: 800_000, gzip: 250_000 },
      },
      totals: { js: { raw: 1_300_000, gzip: 370_000 }, css: { raw: 200_000, gzip: 40_000 } },
    });
    const result = compareReports(current, baseline, 0.05);
    expect(result.ok).toBe(true);
    expect(result.chunkDeltas.some((d) => d.name === "vendor-xterm" && d.current === 0)).toBe(true);
  });

  it("handles missing CSS in baseline", () => {
    const noCss = { ...baseline, totals: { js: baseline.totals.js, css: { raw: 0, gzip: 0 } } };
    const current = makeReport();
    const result = compareReports(current, noCss, 0.05);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.metric === "total CSS gzip")).toBe(true);
  });

  it("detects regression when entry chunk name changes", () => {
    const current = makeReport({
      entryChunk: "app",
      chunks: {
        app: { raw: 600_000, gzip: 200_000 },
        vendor: { raw: 800_000, gzip: 250_000 },
        "vendor-xterm": { raw: 300_000, gzip: 90_000 },
      },
      totals: { js: { raw: 1_700_000, gzip: 540_000 }, css: { raw: 200_000, gzip: 40_000 } },
    });
    const result = compareReports(current, baseline, 0.05);
    // Both old entry ("main") and new entry ("app") should be checked
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.name === "app")).toBe(true);
  });
});

describe("formatMarkdown", () => {
  it("produces a markdown table with headers", () => {
    const baseline = makeReport();
    const current = makeReport();
    const comparison = compareReports(current, baseline, 0.05);
    const md = formatMarkdown(comparison, 0.05);
    expect(md).toContain("### Renderer Bundle Size Report");
    expect(md).toContain("| Chunk |");
    expect(md).toContain("**Total JS**");
    expect(md).toContain("**Total CSS**");
  });

  it("includes FAIL status when there are regressions", () => {
    const baseline = makeReport();
    const current = makeReport({
      chunks: {
        main: { raw: 500_000, gzip: 127_000 },
        vendor: { raw: 800_000, gzip: 250_000 },
        "vendor-xterm": { raw: 300_000, gzip: 90_000 },
      },
      totals: { js: { raw: 1_600_000, gzip: 467_000 }, css: { raw: 200_000, gzip: 40_000 } },
    });
    const comparison = compareReports(current, baseline, 0.05);
    const md = formatMarkdown(comparison, 0.05);
    expect(md).toContain("FAIL");
    expect(md).toContain("**Regressions**");
  });

  it("includes improvements section when sizes shrink", () => {
    const baseline = makeReport();
    const current = makeReport({
      chunks: {
        main: { raw: 400_000, gzip: 100_000 },
        vendor: { raw: 800_000, gzip: 250_000 },
        "vendor-xterm": { raw: 300_000, gzip: 90_000 },
      },
      totals: { js: { raw: 1_500_000, gzip: 440_000 }, css: { raw: 200_000, gzip: 40_000 } },
    });
    const comparison = compareReports(current, baseline, 0.05);
    const md = formatMarkdown(comparison, 0.05);
    expect(md).toContain("**Improvements**");
    expect(md).toContain("renderer-bundle-budget:update");
  });
});
