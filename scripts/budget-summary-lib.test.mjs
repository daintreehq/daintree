import { describe, it, expect } from "vitest";
import { formatBudgetSummary, DEFAULT_MAX_CHARS } from "./budget-summary-lib.mjs";

describe("formatBudgetSummary — structure", () => {
  const md = formatBudgetSummary({
    title: "Compiler bailout budget",
    status: "PASS",
    headerLine: "196 files, 0 regressions",
    sections: [
      { heading: "Totals", body: ["- success: 1234", "- skip: 56"] },
      { heading: "Improvements", body: ["- foo.ts: skip 2 → 1"] },
    ],
  });

  it("opens with <details> and closes with </details>", () => {
    expect(md.startsWith("<details>")).toBe(true);
    expect(md.endsWith("</details>")).toBe(true);
  });

  it("puts a plain-text PASS one-liner in the <summary> tag", () => {
    expect(md).toContain("<summary>PASS — 196 files, 0 regressions</summary>");
  });

  it("keeps a blank line after </summary> so the table/list renders", () => {
    expect(md).toContain("</summary>\n\n## Compiler bailout budget");
  });

  it("keeps a blank line before </details>", () => {
    expect(md).toMatch(/\n\n<\/details>$/);
  });

  it("renders section headings and body lines", () => {
    expect(md).toContain("### Totals");
    expect(md).toContain("- success: 1234");
    expect(md).toContain("### Improvements");
    expect(md).toContain("- foo.ts: skip 2 → 1");
  });
});

describe("formatBudgetSummary — status", () => {
  it("surfaces FAIL in the summary one-liner", () => {
    const md = formatBudgetSummary({
      title: "Main import budget",
      status: "FAIL",
      headerLine: "3 error(s)",
      sections: [{ heading: "Errors", body: ["- electron/foo.ts: sync fs call"] }],
    });
    expect(md).toContain("<summary>FAIL — 3 error(s)</summary>");
  });
});

describe("formatBudgetSummary — empty sections", () => {
  it("drops sections with empty bodies", () => {
    const md = formatBudgetSummary({
      title: "Renderer import budget",
      status: "PASS",
      headerLine: "42 chunks",
      sections: [
        { heading: "Added", body: [] },
        { heading: "Removed", body: [] },
      ],
    });
    expect(md).not.toContain("### Added");
    expect(md).not.toContain("### Removed");
    // The title is always present even with no sections.
    expect(md).toContain("## Renderer import budget");
  });

  it("tolerates a missing sections argument", () => {
    const md = formatBudgetSummary({
      title: "Empty",
      status: "PASS",
      headerLine: "ok",
    });
    expect(md).toContain("## Empty");
    expect(md.endsWith("</details>")).toBe(true);
  });
});

describe("formatBudgetSummary — size guard", () => {
  it("truncates body rows when over the cap and stays within it", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `- chunk-${i}: ${i} bytes`);
    const md = formatBudgetSummary({
      title: "Big report",
      status: "PASS",
      headerLine: "lots of chunks",
      sections: [{ heading: "Chunks", body }],
      maxChars: 2000,
    });
    expect(md.length).toBeLessThanOrEqual(2000);
  });

  it("always closes the <details> block after truncation", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `- chunk-${i}: ${i} bytes`);
    const md = formatBudgetSummary({
      title: "Big report",
      status: "FAIL",
      headerLine: "lots of chunks",
      sections: [{ heading: "Chunks", body }],
      maxChars: 2000,
    });
    expect(md.endsWith("\n\n</details>")).toBe(true);
  });

  it("emits an omission notice when content is trimmed", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `- chunk-${i}: ${i} bytes`);
    const md = formatBudgetSummary({
      title: "Big report",
      status: "PASS",
      headerLine: "lots of chunks",
      sections: [{ heading: "Chunks", body }],
      maxChars: 2000,
    });
    expect(md).toMatch(/_\[\d+ line\(s\) omitted — summary exceeded 2000-character cap\]_/);
  });

  it("retains the title line even under aggressive truncation", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `- chunk-${i}: ${i} bytes`);
    const md = formatBudgetSummary({
      title: "Big report",
      status: "PASS",
      headerLine: "lots of chunks",
      sections: [{ heading: "Chunks", body }],
      maxChars: 2000,
    });
    expect(md).toContain("## Big report");
  });

  it("reports the exact number of omitted lines in the notice", () => {
    // 10 deterministic entry lines. Truncation drops from the end, so only
    // entry lines (never the "## T" / "### S" structural lines) get dropped as
    // long as at least one entry survives — making the count exactly checkable.
    const body = Array.from({ length: 10 }, (_, i) => `- line ${i}`);
    const opts = {
      title: "T",
      status: "PASS",
      headerLine: "h",
      sections: [{ heading: "S", body }],
    };
    const full = formatBudgetSummary(opts);
    const md = formatBudgetSummary({ ...opts, maxChars: full.length - 30 });

    const m = md.match(/_\[(\d+) line\(s\) omitted/);
    expect(m).not.toBeNull();
    const reported = Number(m[1]);
    const present = body.filter((line) => md.includes(line)).length;
    expect(present).toBeGreaterThan(0); // structural lines were retained
    expect(reported).toBe(body.length - present);
  });

  it("does not truncate when output is exactly at the cap, truncates one char under", () => {
    const body = Array.from({ length: 50 }, (_, i) => `- chunk-${i}`);
    const opts = {
      title: "Boundary",
      status: "PASS",
      headerLine: "edge",
      sections: [{ heading: "Chunks", body }],
    };
    const exact = formatBudgetSummary(opts);
    // At exactly the assembled length, the <= guard must NOT truncate.
    const atCap = formatBudgetSummary({ ...opts, maxChars: exact.length });
    expect(atCap).toBe(exact);
    expect(atCap).not.toContain("omitted");
    // One character under forces truncation.
    const underCap = formatBudgetSummary({ ...opts, maxChars: exact.length - 1 });
    expect(underCap).toContain("omitted");
    expect(underCap.length).toBeLessThanOrEqual(exact.length - 1);
  });

  it("leaves content untouched when comfortably under the cap", () => {
    const md = formatBudgetSummary({
      title: "Small report",
      status: "PASS",
      headerLine: "ok",
      sections: [{ heading: "Chunks", body: ["- a: 1", "- b: 2"] }],
    });
    expect(md).toContain("- a: 1");
    expect(md).toContain("- b: 2");
    expect(md).not.toContain("omitted");
    expect(md.length).toBeLessThan(DEFAULT_MAX_CHARS);
  });
});
