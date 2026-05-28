import { describe, it, expect } from "vitest";
import {
  STALE_THRESHOLD_DAYS,
  extractQuarantineAnnotations,
  daysSince,
  isStale,
  collectStaleQuarantines,
  buildIssueTitle,
  buildIssueBody,
} from "./stale-quarantine-lib.mjs";

// Real-world annotation shapes copied from the migrated spec files.
const INLINE_ANNOTATION = `
  test.beforeAll(() => {
    test.info().annotations.push({
      type: "quarantine",
      description: "2026-05-27 webview instability causes Electron crash in E2E sequence",
    });
  });
`;

const WRAPPED_DESCRIPTION = `
  // rest of the full suite green on this Mac; tracked separately.
  test.info().annotations.push({
    type: "quarantine",
    description:
      "2026-05-27 Full test quarantined: dev-preview: OAuth redirect blocked",
  });
`;

describe("extractQuarantineAnnotations", () => {
  it("parses a single inline annotation", () => {
    const result = extractQuarantineAnnotations(INLINE_ANNOTATION);
    expect(result).toEqual([
      {
        date: "2026-05-27",
        description: "2026-05-27 webview instability causes Electron crash in E2E sequence",
      },
    ]);
  });

  it("parses a description that wraps onto its own line", () => {
    const result = extractQuarantineAnnotations(WRAPPED_DESCRIPTION);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-05-27");
    expect(result[0].description).toContain("OAuth redirect blocked");
  });

  it("parses multiple annotations in one source", () => {
    const source = INLINE_ANNOTATION + WRAPPED_DESCRIPTION;
    const result = extractQuarantineAnnotations(source);
    expect(result).toHaveLength(2);
  });

  it("ignores commented-out annotations", () => {
    const source = `
      // test.info().annotations.push({
      //   type: "quarantine",
      //   description: "2026-01-01 disabled long ago",
      // });
      /* test.info().annotations.push({ type: "quarantine", description: "2026-01-02 block" }); */
    `;
    expect(extractQuarantineAnnotations(source)).toEqual([]);
  });

  it("does not corrupt a description containing a URL", () => {
    const source = `
      test.info().annotations.push({
        type: "quarantine",
        description: "2026-05-27 see https://example.com/issue for context",
      });
    `;
    const result = extractQuarantineAnnotations(source);
    expect(result[0].description).toBe("2026-05-27 see https://example.com/issue for context");
  });

  it("does not corrupt a description containing a bare //", () => {
    const source = `
      test.info().annotations.push({
        type: "quarantine",
        description: "2026-05-27 flaky // only on CI runners",
      });
    `;
    const result = extractQuarantineAnnotations(source);
    expect(result).toEqual([
      { date: "2026-05-27", description: "2026-05-27 flaky // only on CI runners" },
    ]);
  });

  it("skips annotations with keys in reverse order (type must precede description)", () => {
    const source = `annotations.push({ description: "2026-05-27 reversed", type: "quarantine" });`;
    expect(extractQuarantineAnnotations(source)).toEqual([]);
  });

  it("returns an empty array when there are no annotations", () => {
    expect(extractQuarantineAnnotations("const x = 1;")).toEqual([]);
  });

  it("records a null date when the description has no leading date", () => {
    const source = `
      test.info().annotations.push({
        type: "quarantine",
        description: "no date prefix here",
      });
    `;
    expect(extractQuarantineAnnotations(source)).toEqual([
      { date: null, description: "no date prefix here" },
    ]);
  });

  it("handles single-quoted annotations", () => {
    const source = `annotations.push({ type: 'quarantine', description: '2026-05-27 single quotes' });`;
    const result = extractQuarantineAnnotations(source);
    expect(result[0].date).toBe("2026-05-27");
  });
});

describe("daysSince", () => {
  it("counts whole days between dates in UTC", () => {
    expect(daysSince("2026-05-27", new Date("2026-06-27T00:00:00.000Z"))).toBe(31);
  });

  it("returns Infinity for an unparseable date", () => {
    expect(daysSince("not-a-date", new Date())).toBe(Infinity);
  });
});

describe("isStale", () => {
  const now = new Date("2026-06-27T00:00:00.000Z");

  it("is not stale at exactly the threshold", () => {
    // 2026-05-28 -> 2026-06-27 is exactly 30 days.
    expect(isStale("2026-05-28", now)).toBe(false);
  });

  it("is stale one day past the threshold", () => {
    // 2026-05-27 -> 2026-06-27 is 31 days.
    expect(isStale("2026-05-27", now)).toBe(true);
  });

  it("treats a null date as stale", () => {
    expect(isStale(null, now)).toBe(true);
  });

  it("treats a malformed date as stale", () => {
    expect(isStale("yesterday", now)).toBe(true);
  });

  it("treats a calendar-overflow date as stale", () => {
    // 2026-02-31 would silently roll to March 3 — reject it instead.
    expect(isStale("2026-02-31", now)).toBe(true);
  });

  it("treats a future date as stale (likely a typo)", () => {
    expect(isStale("3026-01-01", now)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(isStale("2026-06-20", now, 5)).toBe(true);
    expect(isStale("2026-06-20", now, 10)).toBe(false);
  });
});

describe("collectStaleQuarantines", () => {
  const now = new Date("2026-07-01T00:00:00.000Z");

  it("groups stale annotations by spec and skips fresh ones", () => {
    const files = [
      { path: "e2e/a.spec.ts", source: INLINE_ANNOTATION },
      {
        path: "e2e/b.spec.ts",
        source: `annotations.push({ type: "quarantine", description: "${todayIso(now)} fresh" });`,
      },
    ];
    const result = collectStaleQuarantines(files, now);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("e2e/a.spec.ts");
    expect(result[0].stale[0].ageDays).toBe(35);
  });

  it("includes a null ageDays for undated stale annotations", () => {
    const files = [
      {
        path: "e2e/c.spec.ts",
        source: `annotations.push({ type: "quarantine", description: "undated reason" });`,
      },
    ];
    const result = collectStaleQuarantines(files, now);
    expect(result[0].stale[0]).toMatchObject({ date: null, ageDays: null });
  });

  it("returns every stale annotation from a single spec", () => {
    const source = `
      annotations.push({ type: "quarantine", description: "2026-01-01 first" });
      annotations.push({ type: "quarantine", description: "2026-02-01 second" });
      annotations.push({ type: "quarantine", description: "2026-03-01 third" });
    `;
    const result = collectStaleQuarantines([{ path: "e2e/e.spec.ts", source }], now);
    expect(result).toHaveLength(1);
    expect(result[0].stale).toHaveLength(3);
  });

  it("reports a calendar-overflow date as stale with a null ageDays", () => {
    const files = [
      {
        path: "e2e/f.spec.ts",
        source: `annotations.push({ type: "quarantine", description: "2026-02-31 impossible" });`,
      },
    ];
    const result = collectStaleQuarantines(files, now);
    expect(result[0].stale[0]).toMatchObject({ date: "2026-02-31", ageDays: null });
  });

  it("returns an empty array when nothing is stale", () => {
    const files = [
      {
        path: "e2e/d.spec.ts",
        source: `annotations.push({ type: "quarantine", description: "${todayIso(now)} fresh" });`,
      },
    ];
    expect(collectStaleQuarantines(files, now)).toEqual([]);
  });
});

describe("buildIssueTitle", () => {
  it("is sentence case with no terminal period and carries the spec path", () => {
    const title = buildIssueTitle("e2e/full/panels/core-browser-panel.spec.ts");
    expect(title).toBe("Stale quarantined test in e2e/full/panels/core-browser-panel.spec.ts");
    expect(title.endsWith(".")).toBe(false);
  });
});

describe("buildIssueBody", () => {
  it("lists each stale entry and includes the run link and dedup marker", () => {
    const body = buildIssueBody(
      "e2e/full/panels/core-browser-panel.spec.ts",
      [{ date: "2026-05-27", ageDays: 35, description: "2026-05-27 webview crash" }],
      "https://github.com/daintreehq/daintree/actions/runs/123"
    );
    expect(body).toContain("e2e/full/panels/core-browser-panel.spec.ts");
    expect(body).toContain(String(STALE_THRESHOLD_DAYS));
    expect(body).toContain("35 days old");
    expect(body).toContain("webview crash");
    expect(body).toContain("**Run:** https://github.com/daintreehq/daintree/actions/runs/123");
    expect(body).toContain(
      "<!-- stale-quarantine-spec:e2e/full/panels/core-browser-panel.spec.ts -->"
    );
  });

  it("renders undated entries without crashing", () => {
    const body = buildIssueBody("e2e/x.spec.ts", [
      { date: null, ageDays: null, description: "undated reason" },
    ]);
    expect(body).toContain("undated");
    expect(body).toContain("no parseable date");
  });

  it("labels a future-dated entry", () => {
    const body = buildIssueBody("e2e/x.spec.ts", [
      { date: "3026-01-01", ageDays: -365, description: "3026-01-01 future typo" },
    ]);
    expect(body).toContain("dated in the future");
  });
});

function todayIso(now) {
  return now.toISOString().slice(0, 10);
}
