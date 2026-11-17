import { describe, expect, it } from "vitest";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../../shared/config/mcpLimits.js";
import { safeSerializeToolResult } from "../../../utils/safeSerializeToolResult.js";
import { fitJsonResource, type JsonArrayTrim } from "../resourceJsonBudget.js";

const LIMIT = MCP_RESPONSE_TEXT_MAX_BYTES;

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function rows(count: number, label: string, pad = 200) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    text: `${label}-${i}-${"é".repeat(pad)}`,
  }));
}

describe("fitJsonResource (#17490)", () => {
  const ITEMS: JsonArrayTrim[] = [{ key: "items", keep: "head", note: "page note" }];

  it("returns an in-budget body exactly as the indented serializer writes it", () => {
    const value = { items: rows(3, "a"), hasMore: false };
    expect(fitJsonResource(value, ITEMS)).toBe(safeSerializeToolResult(value));
  });

  it("serializes null and undefined as JSON null", () => {
    expect(fitJsonResource(null, ITEMS)).toBe("null");
    expect(fitJsonResource(undefined, ITEMS)).toBe("null");
  });

  it("serializes a string result as a JSON string rather than passing it through raw", () => {
    expect(JSON.parse(fitJsonResource("not json", ITEMS))).toBe("not json");
  });

  it("sends the whole body compact when only the indentation is over", () => {
    const value = { items: Array.from({ length: 4_000 }, (_, i) => ({ n: i })) };
    expect(bytes(safeSerializeToolResult(value))).toBeGreaterThan(LIMIT);
    expect(bytes(JSON.stringify(value))).toBeLessThanOrEqual(LIMIT);

    expect(fitJsonResource(value, ITEMS)).toBe(JSON.stringify(value));
  });

  it("keeps the longest head of rows that fits, with metadata, and no more", () => {
    const items = rows(300, "row");
    const value = { items, nextCursor: "c2", hasMore: true, totalCount: 999 };
    const originalBytes = bytes(JSON.stringify(value));

    const text = fitJsonResource(value, ITEMS);

    expect(bytes(text)).toBeLessThanOrEqual(LIMIT);
    const parsed = JSON.parse(text);
    const kept = parsed.items.length;
    expect(kept).toBeGreaterThan(0);
    expect(parsed.items).toEqual(items.slice(0, kept));
    expect(parsed).toMatchObject({ nextCursor: "c2", hasMore: true, totalCount: 999 });
    expect(parsed.truncated).toEqual({
      maxBytes: LIMIT,
      originalBytes,
      omitted: { items: items.length - kept },
      note: "page note",
    });
    // Metadata leads, so a client that trims the text again keeps it.
    expect(text.startsWith('{"truncated":')).toBe(true);

    const oneMore = JSON.stringify({
      truncated: { ...parsed.truncated, omitted: { items: items.length - kept - 1 } },
      ...value,
      items: items.slice(0, kept + 1),
    });
    expect(bytes(oneMore)).toBeGreaterThan(LIMIT);
  });

  it("keeps the newest tail of a chronological array", () => {
    const heatmap = rows(400, "day", 100);
    const text = fitJsonResource({ heatmap, total: 400 }, [{ key: "heatmap", keep: "tail" }]);

    expect(bytes(text)).toBeLessThanOrEqual(LIMIT);
    const parsed = JSON.parse(text);
    expect(parsed.heatmap).toEqual(heatmap.slice(-parsed.heatmap.length));
    expect(parsed.total).toBe(400);
    expect(parsed.truncated.omitted).toEqual({ heatmap: heatmap.length - parsed.heatmap.length });
    expect(parsed.truncated).not.toHaveProperty("note");
  });

  it("shortens the first-listed array before the protected one and omits zero counts", () => {
    const trims: JsonArrayTrim[] = [
      { key: "heatmap", keep: "tail" },
      { key: "commits", keep: "head", note: "commit note" },
    ];
    const commits = rows(10, "commit");
    const heatmap = rows(600, "day", 60);

    const parsed = JSON.parse(fitJsonResource({ heatmap, commits }, trims));

    expect(parsed.commits).toEqual(commits);
    expect(parsed.heatmap.length).toBeGreaterThan(0);
    expect(parsed.heatmap).toEqual(heatmap.slice(-parsed.heatmap.length));
    expect(parsed.truncated.omitted).toEqual({ heatmap: heatmap.length - parsed.heatmap.length });
    expect(parsed.truncated).not.toHaveProperty("note");
  });

  it("refills the first-listed array with what the protected one leaves over", () => {
    const trims: JsonArrayTrim[] = [
      { key: "heatmap", keep: "tail" },
      { key: "commits", keep: "head" },
    ];
    const commits = rows(400, "commit");
    const heatmap = Array.from({ length: 50 }, (_, i) => i);

    const text = fitJsonResource({ heatmap, commits }, trims);

    expect(bytes(text)).toBeLessThanOrEqual(LIMIT);
    const parsed = JSON.parse(text);
    const keptCommits = parsed.commits.length;
    expect(keptCommits).toBeLessThan(commits.length);
    expect(parsed.commits).toEqual(commits.slice(0, keptCommits));
    expect(parsed.heatmap).toEqual(heatmap.slice(-parsed.heatmap.length));
    expect(parsed.truncated.omitted).toMatchObject({ commits: commits.length - keptCommits });
    // The leftover after the last commit that fits holds some of the short cells.
    expect(parsed.heatmap.length).toBeGreaterThan(0);
  });

  it("keeps the page envelope with no rows when even the first row is too large", () => {
    const items = [
      { id: 1, text: "x".repeat(LIMIT) },
      { id: 2, text: "small" },
    ];
    const value = { items, nextCursor: null, hasMore: false };

    const text = fitJsonResource(value, ITEMS);

    expect(bytes(text)).toBeLessThanOrEqual(LIMIT);
    const parsed = JSON.parse(text);
    expect(parsed.items).toEqual([]);
    expect(parsed).toMatchObject({ nextCursor: null, hasMore: false });
    expect(parsed.truncated.omitted).toEqual({ items: 2 });
    expect(parsed.truncated.note).toBe("page note");
  });

  it.each([
    ["an oversized root array", rows(400, "row")],
    ["an oversized field no trim names", { items: [], blob: "x".repeat(LIMIT) }],
    [
      "a payload that already carries a truncated field",
      { truncated: false, items: rows(400, "r") },
    ],
    ["an oversized string", "y".repeat(LIMIT + 1)],
  ])("replaces %s with metadata alone", (_label, value) => {
    const text = fitJsonResource(value, ITEMS);

    expect(bytes(text)).toBeLessThanOrEqual(LIMIT);
    expect(JSON.parse(text)).toEqual({
      truncated: {
        maxBytes: LIMIT,
        originalBytes: bytes(JSON.stringify(value)),
        payloadOmitted: true,
      },
    });
  });

  it("replaces a value the serializer could not write as JSON with metadata alone", () => {
    const value = {
      toJSON() {
        throw new Error("boom");
      },
    };

    const parsed = JSON.parse(fitJsonResource(value, ITEMS));

    expect(parsed.truncated).toMatchObject({ maxBytes: LIMIT, payloadOmitted: true });
  });
});
