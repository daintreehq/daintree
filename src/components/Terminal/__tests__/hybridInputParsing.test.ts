import { describe, expect, it } from "vitest";
import type { CompletionTrigger } from "@shared/types";
import {
  getActiveCompletionContext,
  getDaintreeAtClaim,
  matchesDiffPrefix,
  matchesTerminalPrefix,
  matchesSelectionPrefix,
  fileSearchQuery,
  getLeadingSlashCommand,
  getAllSlashCommandTokens,
  getAllAtDiffTokens,
  getAllAtTerminalTokens,
  getAllAtSelectionTokens,
} from "../hybridInputParsing";

const ALL: ReadonlySet<CompletionTrigger> = new Set(["/", "$", "@"]);
const SLASH_AT: ReadonlySet<CompletionTrigger> = new Set(["/", "@"]);

describe("getActiveCompletionContext", () => {
  it("detects an @ file token at the caret", () => {
    const text = "run @src/App.tsx please";
    const caret = "run @src/".length;
    const ctx = getActiveCompletionContext(text, caret, ALL);
    expect(ctx).not.toBeNull();
    expect(ctx?.triggerChar).toBe("@");
    expect(ctx?.start).toBe(4);
    expect(ctx?.tokenEnd).toBe("run @src/App.tsx".length);
    expect(ctx?.query).toBe("src/");
  });

  it("detects a slash command at start of input", () => {
    const ctx = getActiveCompletionContext("/help", 2, ALL);
    expect(ctx?.triggerChar).toBe("/");
    expect(ctx?.start).toBe(0);
    expect(ctx?.query).toBe("h");
  });

  it("detects a $ capability token", () => {
    const ctx = getActiveCompletionContext("$neo", 4, ALL);
    expect(ctx?.triggerChar).toBe("$");
    expect(ctx?.start).toBe(0);
    expect(ctx?.tokenEnd).toBe(4);
    expect(ctx?.query).toBe("neo");
  });

  it("only activates triggers in the active set", () => {
    expect(getActiveCompletionContext("$neo", 4, SLASH_AT)).toBeNull();
    expect(getActiveCompletionContext("$neo", 4, ALL)?.triggerChar).toBe("$");
  });

  it("detects a token mid-text after whitespace / tab / newline", () => {
    expect(getActiveCompletionContext("echo /help", "echo /h".length, ALL)?.start).toBe(5);
    expect(getActiveCompletionContext("text\t/compact", "text\t/com".length, ALL)?.query).toBe(
      "com"
    );
    expect(getActiveCompletionContext("line1\n/help", "line1\n/he".length, ALL)?.start).toBe(6);
  });

  it("rejects a trigger not preceded by whitespace (URLs, emails, paths)", () => {
    expect(getActiveCompletionContext("email@test.com", "email@test.com".length, ALL)).toBeNull();
    expect(getActiveCompletionContext("http://example.com", 8, ALL)).toBeNull();
    expect(getActiveCompletionContext("path/to/file", 6, ALL)).toBeNull();
  });

  it("rejects doubled triggers (//help, $$foo, @@x)", () => {
    expect(getActiveCompletionContext("//help", 3, ALL)).toBeNull();
    expect(getActiveCompletionContext("$$foo", 3, ALL)).toBeNull();
    expect(getActiveCompletionContext("@@x", 3, ALL)).toBeNull();
  });

  it("rejects a repeated same-trigger later in the token (/usr/bin, @foo@bar)", () => {
    // A second `/` in a `/` token is a path, not a command session.
    expect(getActiveCompletionContext("/usr/bin", "/usr/bin".length, ALL)).toBeNull();
    // ...but a bare `/usr` (no inner slash yet) is still a command session.
    expect(getActiveCompletionContext("/usr", 4, ALL)?.query).toBe("usr");
    // A second `@` in an `@` token is rejected (matches the old last-@ parser).
    expect(getActiveCompletionContext("@foo@bar", "@foo@bar".length, ALL)).toBeNull();
    // The `/` inside an `@` file token is NOT a repeat — it stays open.
    expect(getActiveCompletionContext("@src/App.tsx", "@src/App.tsx".length, ALL)?.query).toBe(
      "src/App.tsx"
    );
  });

  it("handles caret exactly at boundaries and after CRLF", () => {
    // Caret on the trigger itself (start === caret) — nothing typed yet.
    expect(getActiveCompletionContext("echo @", 5, ALL)).toBeNull();
    // Caret at token end just before whitespace — active.
    expect(getActiveCompletionContext("@diff here", 5, ALL)).toMatchObject({
      triggerChar: "@",
      tokenEnd: 5,
      query: "diff",
    });
    // Caret immediately after a delimiter (before a trigger not yet typed past).
    expect(getActiveCompletionContext("a @", 2, ALL)).toBeNull();
    // Active token after CRLF.
    expect(getActiveCompletionContext("x\r\n/help", "x\r\n/he".length, ALL)?.triggerChar).toBe("/");
  });

  it("is inactive when the caret is in the token's arguments", () => {
    expect(getActiveCompletionContext("/open src/App.tsx", "/open src/App.tsx".length, ALL)).toBe(
      null
    );
  });

  it("anchors on the second token when the caret is inside it", () => {
    const text = "/help /compact";
    const ctx = getActiveCompletionContext(text, "/help /com".length, ALL);
    expect(ctx?.start).toBe(6);
    expect(ctx?.tokenEnd).toBe(14);
    expect(ctx?.query).toBe("com");
  });

  it("activates for a bare trigger", () => {
    expect(getActiveCompletionContext("/", 1, ALL)).toMatchObject({ triggerChar: "/", query: "" });
    expect(getActiveCompletionContext("echo @", 6, ALL)).toMatchObject({
      triggerChar: "@",
      query: "",
    });
  });

  it("activates with the caret in the middle of a token", () => {
    const ctx = getActiveCompletionContext("@diff:staged", "@diff:st".length, ALL);
    expect(ctx?.triggerChar).toBe("@");
    expect(ctx?.start).toBe(0);
    expect(ctx?.query).toBe("diff:st");
  });

  it("returns null when the caret precedes the trigger or follows the token", () => {
    expect(getActiveCompletionContext("check @diff", 3, ALL)).toBeNull();
    expect(getActiveCompletionContext("@diff rest", "@diff r".length, ALL)).toBeNull();
  });
});

describe("getDaintreeAtClaim + prefix matchers", () => {
  it("claims diff for a bare @ and diff prefixes", () => {
    expect(getDaintreeAtClaim("")).toBe("diff");
    expect(getDaintreeAtClaim("diff")).toBe("diff");
    expect(getDaintreeAtClaim("diff:s")).toBe("diff");
    expect(matchesDiffPrefix("")).toBe(true);
  });

  it("claims terminal/selection only from four chars in", () => {
    expect(getDaintreeAtClaim("te")).toBeNull();
    expect(getDaintreeAtClaim("term")).toBe("terminal");
    expect(getDaintreeAtClaim("sele")).toBe("selection");
    expect(matchesTerminalPrefix("ter")).toBe(false);
    expect(matchesSelectionPrefix("sel")).toBe(false);
  });

  it("falls through to file search for non-provider queries", () => {
    expect(getDaintreeAtClaim("src/")).toBeNull();
    expect(getDaintreeAtClaim("ters")).toBeNull();
  });
});

describe("fileSearchQuery", () => {
  it("strips a single leading quote", () => {
    expect(fileSearchQuery('"My')).toBe("My");
    expect(fileSearchQuery("src/")).toBe("src/");
  });
});

describe("getLeadingSlashCommand", () => {
  it("detects a leading slash command", () => {
    const token = getLeadingSlashCommand("/help");
    expect(token).not.toBeNull();
    expect(token?.start).toBe(0);
    expect(token?.end).toBe(5);
    expect(token?.command).toBe("/help");
  });

  it("detects command with arguments", () => {
    const token = getLeadingSlashCommand("/review @src/file.ts");
    expect(token).not.toBeNull();
    expect(token?.command).toBe("/review");
    expect(token?.end).toBe(7);
  });

  it("returns null for text not starting with slash", () => {
    expect(getLeadingSlashCommand("echo /help")).toBeNull();
    expect(getLeadingSlashCommand("  /help")).toBeNull();
  });

  it("returns null for slash-only input", () => {
    expect(getLeadingSlashCommand("/")).toBeNull();
  });

  it("handles mixed input with @file references", () => {
    const text = "/compact @src/App.tsx some text";
    const slashToken = getLeadingSlashCommand(text);
    const atContext = getActiveCompletionContext(text, text.indexOf("@") + 1, ALL);

    expect(slashToken?.command).toBe("/compact");
    expect(atContext).not.toBeNull();
    expect(atContext?.triggerChar).toBe("@");
    expect(atContext?.start).toBe(9);
  });

  it("only treats first slash as command", () => {
    const token = getLeadingSlashCommand("/help /other");
    expect(token?.command).toBe("/help");
    expect(token?.end).toBe(5);
  });

  it("handles tab-delimited commands", () => {
    const token = getLeadingSlashCommand("/review\t@file.ts");
    expect(token?.command).toBe("/review");
    expect(token?.end).toBe(7);
  });

  it("handles newline-delimited commands", () => {
    const token = getLeadingSlashCommand("/help\nmore text");
    expect(token?.command).toBe("/help");
    expect(token?.end).toBe(5);
  });

  it("handles CRLF-delimited commands", () => {
    const token = getLeadingSlashCommand("/compact\r\nmore");
    expect(token?.command).toBe("/compact");
    expect(token?.end).toBe(8);
  });
});

describe("getAllSlashCommandTokens", () => {
  it("finds multiple slash commands in text", () => {
    const tokens = getAllSlashCommandTokens("please /compact now and /clear later");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toEqual({ start: 7, end: 15, command: "/compact" });
    expect(tokens[1]).toEqual({ start: 24, end: 30, command: "/clear" });
  });

  it("finds a single token at start", () => {
    const tokens = getAllSlashCommandTokens("/help");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ start: 0, end: 5, command: "/help" });
  });

  it("finds token at end of text", () => {
    const tokens = getAllSlashCommandTokens("do /compact");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ start: 3, end: 11, command: "/compact" });
  });

  it("skips slashes inside URLs", () => {
    const tokens = getAllSlashCommandTokens("visit http://example.com/page");
    expect(tokens).toHaveLength(0);
  });

  it("skips bare slash with nothing after", () => {
    const tokens = getAllSlashCommandTokens("test / end");
    expect(tokens).toHaveLength(0);
  });

  it("handles tab-delimited tokens", () => {
    const tokens = getAllSlashCommandTokens("/help\t/compact");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toEqual({ start: 0, end: 5, command: "/help" });
    expect(tokens[1]).toEqual({ start: 6, end: 14, command: "/compact" });
  });

  it("handles newline-delimited tokens", () => {
    const tokens = getAllSlashCommandTokens("/help\n/compact");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toEqual({ start: 0, end: 5, command: "/help" });
    expect(tokens[1]).toEqual({ start: 6, end: 14, command: "/compact" });
  });

  it("skips consecutive slashes", () => {
    const tokens = getAllSlashCommandTokens("//help");
    expect(tokens).toHaveLength(0);
  });

  it("returns empty for text with no slash commands", () => {
    const tokens = getAllSlashCommandTokens("just plain text");
    expect(tokens).toHaveLength(0);
  });
});

describe("getAllAtDiffTokens", () => {
  it("finds @diff tokens in text", () => {
    const tokens = getAllAtDiffTokens("check @diff and @diff:staged please");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toEqual({ start: 6, end: 11, diffType: "unstaged" });
    expect(tokens[1]).toEqual({ start: 16, end: 28, diffType: "staged" });
  });

  it("finds @diff:head token", () => {
    const tokens = getAllAtDiffTokens("@diff:head");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ start: 0, end: 10, diffType: "head" });
  });

  it("ignores partial tokens like @dif", () => {
    const tokens = getAllAtDiffTokens("@dif not a diff");
    expect(tokens).toHaveLength(0);
  });

  it("ignores @diff not preceded by whitespace", () => {
    const tokens = getAllAtDiffTokens("email@diff");
    expect(tokens).toHaveLength(0);
  });

  it("returns empty for text with no diff tokens", () => {
    const tokens = getAllAtDiffTokens("just plain text");
    expect(tokens).toHaveLength(0);
  });

  it("finds diff tokens alongside @file tokens", () => {
    const tokens = getAllAtDiffTokens("@diff @src/file.ts @diff:head");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.diffType).toBe("unstaged");
    expect(tokens[1]!.diffType).toBe("head");
  });

  it("handles duplicate diff tokens", () => {
    const tokens = getAllAtDiffTokens("@diff @diff");
    expect(tokens).toHaveLength(2);
  });

  it("handles newline-delimited tokens", () => {
    const tokens = getAllAtDiffTokens("@diff\n@diff:staged");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.diffType).toBe("unstaged");
    expect(tokens[1]!.diffType).toBe("staged");
  });
});

describe("getAllAtTerminalTokens", () => {
  it("finds @terminal tokens in text", () => {
    const tokens = getAllAtTerminalTokens("check @terminal please");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ start: 6, end: 15 });
  });

  it("ignores partial @term (not a complete token)", () => {
    const tokens = getAllAtTerminalTokens("@term not terminal");
    expect(tokens).toHaveLength(0);
  });

  it("finds multiple @terminal tokens", () => {
    const tokens = getAllAtTerminalTokens("@terminal and @terminal");
    expect(tokens).toHaveLength(2);
  });

  it("ignores @terminal not preceded by whitespace", () => {
    const tokens = getAllAtTerminalTokens("no@terminal");
    expect(tokens).toHaveLength(0);
  });

  it("returns empty for text with no terminal tokens", () => {
    const tokens = getAllAtTerminalTokens("just plain text");
    expect(tokens).toHaveLength(0);
  });

  it("finds @terminal alongside @diff and @file tokens", () => {
    const tokens = getAllAtTerminalTokens("@terminal @diff @src/file.ts");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.start).toBe(0);
  });
});

describe("getAllAtSelectionTokens", () => {
  it("finds @selection tokens in text", () => {
    const tokens = getAllAtSelectionTokens("check @selection please");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ start: 6, end: 16 });
  });

  it("ignores partial @sele (not a complete token)", () => {
    const tokens = getAllAtSelectionTokens("@sele not selection");
    expect(tokens).toHaveLength(0);
  });

  it("finds multiple @selection tokens", () => {
    const tokens = getAllAtSelectionTokens("@selection and @selection");
    expect(tokens).toHaveLength(2);
  });

  it("returns empty for text with no selection tokens", () => {
    const tokens = getAllAtSelectionTokens("just plain text");
    expect(tokens).toHaveLength(0);
  });
});
