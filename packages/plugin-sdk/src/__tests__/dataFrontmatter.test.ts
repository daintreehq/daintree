import { describe, expect, it } from "vitest";
import {
  FrontmatterError,
  parseFrontmatter,
  stringifyFrontmatter,
  updateFrontmatter,
} from "../data.js";

const CARD = [
  "---",
  "# Deal card — edited by agents and by the CRM panel",
  "name:   'Acme Corp'   # keep the quotes",
  "stage: lead # pipeline stage",
  "",
  "tags:",
  "  - enterprise",
  "  - q3   # renewal",
  "# owner is a login, not a display name",
  "owner: greg",
  "notes: |",
  "  First call went well.",
  "  Follow up in two weeks.",
  "empty:",
  "---",
  "",
  "# Acme Corp",
  "",
  "Body text with --- inside it.",
  "",
].join("\n");

describe("parseFrontmatter", () => {
  it("splits data from the body byte-for-byte", () => {
    const parsed = parseFrontmatter(CARD);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.data).toEqual({
      name: "Acme Corp",
      stage: "lead",
      tags: ["enterprise", "q3"],
      owner: "greg",
      notes: "First call went well.\nFollow up in two weeks.\n",
      empty: null,
    });
    expect(parsed.body).toBe("\n# Acme Corp\n\nBody text with --- inside it.\n");
  });

  it("treats a document that does not open with --- as all body", () => {
    const text = "# Title\n\n---\nnot: frontmatter\n---\n";
    expect(parseFrontmatter(text)).toEqual({ data: {}, body: text, hasFrontmatter: false });
  });

  it("reads YAML 1.2 core scalars, so yes/no and dates stay strings", () => {
    const { data } = parseFrontmatter("---\nok: yes\ndue: 2026-09-26\ncount: 3\n---\n");
    expect(data).toEqual({ ok: "yes", due: "2026-09-26", count: 3 });
  });

  it("accepts CRLF, a byte order mark, an empty block and a close at end of file", () => {
    expect(parseFrontmatter("\uFEFF---\r\na: 1\r\n---\r\nbody\r\n")).toEqual({
      data: { a: 1 },
      body: "body\r\n",
      hasFrontmatter: true,
    });
    expect(parseFrontmatter("---\n---\nbody")).toEqual({
      data: {},
      body: "body",
      hasFrontmatter: true,
    });
    expect(parseFrontmatter("---\na: 1\n---")).toEqual({
      data: { a: 1 },
      body: "",
      hasFrontmatter: true,
    });
  });

  it("reports invalid YAML with its line in the whole file", () => {
    let caught: unknown;
    try {
      parseFrontmatter("---\ntitle: ok\ntitle: again\n---\nbody\n");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FrontmatterError);
    const error = caught as FrontmatterError;
    expect(error.code).toBe("FRONTMATTER_INVALID");
    expect(error.line).toBe(3);
    expect(error.column).toBe(1);
    expect(error.message).toMatch(/unique/);
  });

  it("reports an alias with no anchor as a FrontmatterError at the alias", () => {
    let caught: unknown;
    try {
      parseFrontmatter("---\ntitle: ok\nowner: *nobody\n---\n");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FrontmatterError);
    expect((caught as FrontmatterError).line).toBe(3);
    expect((caught as FrontmatterError).column).toBe(8);
    expect((caught as FrontmatterError).message).toMatch(/nobody/);
  });

  it("refuses an unclosed block and a non-mapping block", () => {
    expect(() => parseFrontmatter("---\ntitle: x\nbody\n")).toThrow(FrontmatterError);
    expect(() => parseFrontmatter("---\n- a\n- b\n---\n")).toThrow(/mapping/);
  });
});

describe("stringifyFrontmatter", () => {
  it("round-trips through parseFrontmatter", () => {
    const data = { title: "A long title ".repeat(10).trim(), tags: ["a", "b"], n: 1 };
    const body = "\nBody\n";
    const text = stringifyFrontmatter(data, body);
    expect(text.startsWith("---\ntitle: A long title")).toBe(true);
    expect(parseFrontmatter(text)).toEqual({ data, body, hasFrontmatter: true });
  });

  it("omits undefined values and writes an empty block for no data", () => {
    expect(stringifyFrontmatter({ a: undefined }, "x")).toBe("---\n---\nx");
  });
});

describe("updateFrontmatter", () => {
  it("changes one scalar and leaves every other byte alone", () => {
    const updated = updateFrontmatter(CARD, { stage: "won" });
    expect(updated).toBe(
      CARD.replace("stage: lead # pipeline stage", "stage: won # pipeline stage")
    );
  });

  it("keeps a quoted neighbour's quoting and a changed value's trailing comment", () => {
    const updated = updateFrontmatter(CARD, { name: "Acme Inc" });
    expect(updated).toBe(
      CARD.replace(
        "name:   'Acme Corp'   # keep the quotes",
        "name:   Acme Inc   # keep the quotes"
      )
    );
  });

  it("quotes a value that would otherwise read back as another type", () => {
    const updated = updateFrontmatter(CARD, { owner: "123" });
    expect(updated).toBe(CARD.replace("owner: greg", 'owner: "123"'));
    expect(parseFrontmatter(updated).data.owner).toBe("123");
  });

  it("fills an empty value", () => {
    const updated = updateFrontmatter(CARD, { empty: "now set" });
    expect(updated).toBe(CARD.replace("empty:\n", "empty: now set\n"));
  });

  it("deletes a key with undefined, keeping the comment that belongs to the next key", () => {
    const updated = updateFrontmatter(CARD, { tags: undefined });
    expect(updated).toBe(CARD.replace("tags:\n  - enterprise\n  - q3   # renewal\n", ""));
    expect(updated).toContain("# owner is a login");
  });

  it("rewrites only a collection's own lines when it changes", () => {
    const updated = updateFrontmatter(CARD, { tags: ["enterprise", "churn-risk"] });
    expect(updated).toBe(
      CARD.replace(
        "tags:\n  - enterprise\n  - q3   # renewal\n",
        "tags:\n  - enterprise\n  - churn-risk\n"
      )
    );
  });

  it("replaces a block scalar and turns a scalar into a collection", () => {
    const updated = updateFrontmatter(CARD, {
      notes: "Closed.",
      stage: { from: "lead", to: "won" },
    });
    expect(parseFrontmatter(updated).data).toMatchObject({
      notes: "Closed.",
      stage: { from: "lead", to: "won" },
    });
    expect(updated).toContain("notes: Closed.\nempty:\n");
    expect(updated).toContain("stage:\n  from: lead\n  to: won\n\ntags:");
  });

  it("appends a new key at the end of the block", () => {
    const updated = updateFrontmatter(CARD, { closedAt: "2026-09-26" });
    expect(updated).toBe(CARD.replace("empty:\n---\n", "empty:\nclosedAt: 2026-09-26\n---\n"));
    expect(parseFrontmatter(updated).data.closedAt).toBe("2026-09-26");
  });

  it("keeps the body byte-for-byte, including CRLF line endings", () => {
    const crlf = "---\r\na: 1 # one\r\nb: 2\r\n---\r\nBody\r\n\r\nmore\r\n";
    const updated = updateFrontmatter(crlf, { a: 5, c: [1, 2], b: undefined });
    expect(updated).toBe(
      "---\r\na: 5 # one\r\nc:\r\n  - 1\r\n  - 2\r\n---\r\nBody\r\n\r\nmore\r\n"
    );
  });

  it("adds a block to a document that has none, and leaves it alone for a pure delete", () => {
    expect(updateFrontmatter("# Title\n", { stage: "lead" })).toBe(
      "---\nstage: lead\n---\n# Title\n"
    );
    expect(updateFrontmatter("# Title\n", { stage: undefined })).toBe("# Title\n");
  });

  it("writes a new block with the line breaks of a CRLF document", () => {
    expect(updateFrontmatter("# Title\r\nbody\r\n", { stage: "lead", tags: ["a"] })).toBe(
      "---\r\nstage: lead\r\ntags:\r\n  - a\r\n---\r\n# Title\r\nbody\r\n"
    );
  });

  it("returns the text unchanged for an empty patch, flow mapping included", () => {
    expect(updateFrontmatter(CARD, {})).toBe(CARD);
    const flow = "---\n{a:   1,  b: 2}\n---\nbody";
    expect(updateFrontmatter(flow, {})).toBe(flow);
    expect(() => updateFrontmatter("---\na: [\n---\n", {})).toThrow(FrontmatterError);
  });

  it("separates a filled empty value from a trailing comment", () => {
    expect(updateFrontmatter("---\nstage: # pipeline\n---\n", { stage: "won" })).toBe(
      "---\nstage: won # pipeline\n---\n"
    );
  });

  it("drops an explicit tag that would change the new value's type", () => {
    const updated = updateFrontmatter("---\ncount: !!str 1\nother: x\n---\n", { count: 2 });
    expect(updated).toBe("---\ncount: 2\nother: x\n---\n");
    expect(parseFrontmatter(updated).data.count).toBe(2);
  });

  it("keeps an anchor that another key refers to", () => {
    const collection = updateFrontmatter("---\na: &x [1]\nb: *x\n---\n", { a: [2] });
    expect(parseFrontmatter(collection).data).toEqual({ a: [2], b: [2] });
    const scalar = updateFrontmatter("---\na: &x one # c\nb: *x\n---\n", { a: "two" });
    expect(scalar).toBe("---\na: &x two # c\nb: *x\n---\n");
    const tagged = updateFrontmatter("---\na: &x !!str 1\nb: *x\n---\n", { a: 5 });
    expect(parseFrontmatter(tagged).data).toEqual({ a: 5, b: 5 });
  });

  it("refuses to delete a value an alias still points at", () => {
    let caught: unknown;
    try {
      updateFrontmatter("---\na: &x one\nb: *x\n---\n", { a: undefined });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FrontmatterError);
    expect((caught as FrontmatterError).message).toMatch(/unreadable.*x/);
    expect((caught as FrontmatterError).line).toBe(2);
    // Deleting the alias and its anchor together is fine.
    expect(updateFrontmatter("---\na: &x one\nb: *x\n---\n", { a: undefined, b: undefined })).toBe(
      "---\n---\n"
    );
  });

  it("keeps an indented root mapping's indentation", () => {
    const updated = updateFrontmatter("---\n  a: 1\n  b: 2\n---\n", {
      a: [1, 2],
      c: { d: 3 },
    });
    expect(updated).toBe("---\n  a:\n    - 1\n    - 2\n  b: 2\n  c:\n    d: 3\n---\n");
    expect(parseFrontmatter(updated).data).toEqual({ a: [1, 2], b: 2, c: { d: 3 } });
  });

  it("edits a flow mapping by re-serialising it", () => {
    const updated = updateFrontmatter("---\n{ a: 1, b: 2 }\n---\nbody", { b: 3 });
    expect(parseFrontmatter(updated)).toEqual({
      data: { a: 1, b: 3 },
      body: "body",
      hasFrontmatter: true,
    });
  });

  it("throws on invalid frontmatter rather than guessing", () => {
    expect(() => updateFrontmatter("---\na: [\n---\n", { a: 1 })).toThrow(FrontmatterError);
  });
});
