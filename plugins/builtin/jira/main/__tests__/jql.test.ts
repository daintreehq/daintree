import { describe, expect, it } from "vitest";
import {
  buildIssueJql,
  issueFilterJql,
  issueKeyInSearch,
  quoteJql,
  textSearchClause,
} from "../jql.js";

describe("quoteJql", () => {
  it("escapes quotes and backslashes, backslashes first", () => {
    expect(quoteJql('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteJql("C:\\temp")).toBe('"C:\\\\temp"');
    expect(quoteJql('\\"')).toBe('"\\\\\\""');
  });

  it("quotes a project key that is a reserved word", () => {
    expect(issueFilterJql("ALL", "all")).toBe('project = "ALL"');
  });
});

describe("textSearchClause", () => {
  it("searches the words typed, the last as a prefix", () => {
    expect(textSearchClause("fix login")).toBe('text ~ "fix login*"');
  });

  it("escapes a double quote for Lucene and for JQL", () => {
    // Lucene sees \" (a literal quote); JQL needs that backslash and that quote escaped.
    expect(textSearchClause('say "hi" now')).toBe('text ~ "say \\\\\\"hi\\\\\\" now*"');
  });

  it("escapes a backslash for Lucene and for JQL", () => {
    // Lucene sees \\ (a literal backslash); JQL needs each of those escaped.
    expect(textSearchClause("C:\\temp")).toBe('text ~ "C\\\\:\\\\\\\\temp*"');
  });

  it("can't be broken out of with a quote", () => {
    const clause = textSearchClause('x" OR project = "SECRET');
    expect(clause).toBe('text ~ "x\\\\\\" or project = \\\\\\"SECRET*"');
    // Every quote inside the literal sits behind an odd number of backslashes.
    const inner = clause!.slice('text ~ "'.length, -1);
    for (const match of inner.matchAll(/(\\*)"/g)) {
      expect(match[1].length % 2).toBe(1);
    }
  });

  it.each(["+", "-", "&", "|", "!", "(", ")", "{", "}", "[", "]", "^", "~", "*", "?", ":", "/"])(
    "double-escapes the reserved character %s",
    (character) => {
      expect(textSearchClause(`a${character}b`)).toBe(`text ~ "a\\\\${character}b*"`);
    }
  );

  it("takes the operators out of Lucene's reach", () => {
    expect(textSearchClause("OR")).toBe('text ~ "or*"');
    expect(textSearchClause("this AND that NOT other")).toBe('text ~ "this and that not other*"');
    expect(textSearchClause("ORDER Android")).toBe('text ~ "ORDER Android*"');
  });

  it("adds no wildcard after punctuation", () => {
    expect(textSearchClause("fix (login)")).toBe('text ~ "fix \\\\(login\\\\)"');
  });

  it("replaces the control characters JQL refuses", () => {
    expect(textSearchClause("one\ntwo\u0000three")).toBe('text ~ "one two three*"');
  });

  it("matches on letters and numbers beyond ASCII", () => {
    expect(textSearchClause("日本語")).toBe('text ~ "日本語*"');
  });

  it("has nothing to search for without a letter or digit", () => {
    expect(textSearchClause('"')).toBeNull();
    expect(textSearchClause("\\")).toBeNull();
    expect(textSearchClause("  * ? ")).toBeNull();
  });
});

describe("buildIssueJql", () => {
  it("defaults to the project's open issues, newest first", () => {
    expect(buildIssueJql("ENG", {})).toBe(
      'project = "ENG" AND statusCategory != "Done" ORDER BY created DESC'
    );
  });

  it.each([
    ["open", 'project = "ENG" AND statusCategory != "Done" ORDER BY created DESC'],
    ["merged", 'project = "ENG" AND statusCategory != "Done" ORDER BY created DESC'],
    ["closed", 'project = "ENG" AND statusCategory = "Done" ORDER BY created DESC'],
    ["all", 'project = "ENG" ORDER BY created DESC'],
  ] as const)("filters state %s", (state, expected) => {
    expect(buildIssueJql("ENG", { state })).toBe(expected);
  });

  it.each([
    ["created", "asc", "ORDER BY created ASC"],
    ["created", "desc", "ORDER BY created DESC"],
    ["updated", "asc", "ORDER BY updated ASC"],
    ["updated", "desc", "ORDER BY updated DESC"],
  ] as const)("serves sort %s %s", (sort, direction, expected) => {
    expect(buildIssueJql("ENG", { state: "all", sort, direction })).toBe(
      `project = "ENG" ${expected}`
    );
  });

  it("sorts newest first when no direction is given", () => {
    expect(buildIssueJql("ENG", { state: "all", sort: "updated" })).toBe(
      'project = "ENG" ORDER BY updated DESC'
    );
  });

  it("refuses a sort it can't serve by name", () => {
    expect(() => buildIssueJql("ENG", { sort: "comments" })).toThrow(
      /can't sort issues by "comments"/
    );
  });

  it("adds the search inside the project and state", () => {
    expect(buildIssueJql("ENG", { search: " fix " })).toBe(
      'project = "ENG" AND statusCategory != "Done" AND text ~ "fix*" ORDER BY created DESC'
    );
  });

  it("has no query for a search that can't match anything", () => {
    expect(buildIssueJql("ENG", { search: '"' })).toBeNull();
  });

  it("ignores a blank search", () => {
    expect(buildIssueJql("ENG", { state: "all", search: "   " })).toBe(
      'project = "ENG" ORDER BY created DESC'
    );
  });
});

describe("issueKeyInSearch", () => {
  it.each([
    ["ENG-12", "ENG-12"],
    ["eng-12", "ENG-12"],
    ["  ENG-12  ", "ENG-12"],
    ["12", "ENG-12"],
    ["#12", "ENG-12"],
  ])("reads %s as this project's issue", (search, expected) => {
    expect(issueKeyInSearch(search, "ENG")).toBe(expected);
  });

  it.each(["DES-12", "ENGX-12", "ENG-", "ENG-12x", "fix ENG-12", "#", ""])(
    "reads %s as text",
    (search) => {
      expect(issueKeyInSearch(search, "ENG")).toBeNull();
    }
  );
});
