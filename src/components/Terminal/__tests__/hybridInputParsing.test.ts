import { describe, expect, it } from "vitest";
import {
  getAtFileContext,
  getSlashCommandContext,
  getLeadingSlashCommand,
  getAllSlashCommandTokens,
  getDiffContext,
  getAllAtDiffTokens,
  getTerminalContext,
  getAllAtTerminalTokens,
  getSelectionContext,
  getAllAtSelectionTokens,
} from "../hybridInputParsing";

describe("getAtFileContext", () => {
  it("detects an @ token at the caret", () => {
    const text = "run @src/App.tsx please";
    const caret = "run @src/".length;
    const ctx = getAtFileContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.atStart).toBe(4);
    expect(ctx?.tokenEnd).toBe("run @src/App.tsx".length);
    expect(ctx?.queryRaw).toBe("src/");
    expect(ctx?.queryForSearch).toBe("src/");
  });

  it("requires @ to be preceded by whitespace (or start)", () => {
    const text = "email@test.com";
    const caret = text.length;
    expect(getAtFileContext(text, caret)).toBeNull();
  });

  it("strips a leading quote for queryForSearch", () => {
    const text = 'open @"My Folder/file name.txt"';
    const caret = 'open @"My'.length;
    const ctx = getAtFileContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.queryRaw).toBe('"My');
    expect(ctx?.queryForSearch).toBe("My");
  });
});

describe("getSlashCommandContext", () => {
  it("detects a slash command at start of input", () => {
    expect(getSlashCommandContext("/help", 2)?.query).toBe("/h");
  });

  it("detects a slash command mid-text after whitespace", () => {
    const ctx = getSlashCommandContext("echo /help", "echo /h".length);
    expect(ctx).not.toBeNull();
    expect(ctx?.start).toBe(5);
    expect(ctx?.tokenEnd).toBe(10);
    expect(ctx?.query).toBe("/h");
  });

  it("detects slash command after tab", () => {
    const ctx = getSlashCommandContext("text\t/compact", "text\t/com".length);
    expect(ctx).not.toBeNull();
    expect(ctx?.start).toBe(5);
    expect(ctx?.query).toBe("/com");
  });

  it("detects slash command after newline", () => {
    const ctx = getSlashCommandContext("line1\n/help", "line1\n/he".length);
    expect(ctx).not.toBeNull();
    expect(ctx?.start).toBe(6);
    expect(ctx?.query).toBe("/he");
  });

  it("rejects slash inside a URL (not preceded by whitespace)", () => {
    expect(getSlashCommandContext("http://example.com", 8)).toBeNull();
  });

  it("rejects slash not preceded by whitespace", () => {
    expect(getSlashCommandContext("path/to/file", 6)).toBeNull();
  });

  it("is inactive when caret is in arguments", () => {
    const text = "/open src/App.tsx";
    const caret = text.length;
    expect(getSlashCommandContext(text, caret)).toBeNull();
  });

  it("replaces only the first token", () => {
    const text = "/cl arg1";
    const caret = "/cl".length;
    const ctx = getSlashCommandContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.start).toBe(0);
    expect(ctx?.tokenEnd).toBe("/cl".length);
    expect(ctx?.query).toBe("/cl");
  });

  it("returns correct context for second slash command", () => {
    const text = "/help /compact";
    const caret = "/help /com".length;
    const ctx = getSlashCommandContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.start).toBe(6);
    expect(ctx?.tokenEnd).toBe(14);
    expect(ctx?.query).toBe("/com");
  });

  it("rejects consecutive slashes like //help", () => {
    expect(getSlashCommandContext("//help", 3)).toBeNull();
  });

  it("activates for bare slash at start", () => {
    const ctx = getSlashCommandContext("/", 1);
    expect(ctx).not.toBeNull();
    expect(ctx?.start).toBe(0);
    expect(ctx?.tokenEnd).toBe(1);
    expect(ctx?.query).toBe("/");
  });

  it("activates for bare slash mid-text", () => {
    const ctx = getSlashCommandContext("echo /", 6);
    expect(ctx).not.toBeNull();
    expect(ctx?.start).toBe(5);
    expect(ctx?.tokenEnd).toBe(6);
    expect(ctx?.query).toBe("/");
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
    const atContext = getAtFileContext(text, text.indexOf("@") + 1);

    expect(slashToken?.command).toBe("/compact");
    expect(atContext).not.toBeNull();
    expect(atContext?.atStart).toBe(9);
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

describe("getDiffContext", () => {
  it("detects @diff at the caret", () => {
    const text = "check @diff please";
    const caret = "check @diff".length;
    const ctx = getDiffContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.atStart).toBe(6);
    expect(ctx?.tokenEnd).toBe("check @diff".length);
    expect(ctx?.diffType).toBe("unstaged");
  });

  it("detects @diff:staged", () => {
    const text = "show @diff:staged here";
    const caret = "show @diff:staged".length;
    const ctx = getDiffContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.diffType).toBe("staged");
  });

  it("detects @diff:head", () => {
    const text = "@diff:head";
    const caret = text.length;
    const ctx = getDiffContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.diffType).toBe("head");
  });

  it("returns null diffType for partial typing", () => {
    const text = "check @dif";
    const caret = text.length;
    const ctx = getDiffContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.diffType).toBeNull();
  });

  it("returns null for non-diff @ tokens", () => {
    const text = "check @src/file.ts";
    const caret = "check @src/".length;
    expect(getDiffContext(text, caret)).toBeNull();
  });

  it("requires @ to be preceded by whitespace", () => {
    const text = "nodiff@diff";
    const caret = text.length;
    expect(getDiffContext(text, caret)).toBeNull();
  });

  it("returns null for unknown suffixes like @diff:foo", () => {
    const text = "@diff:foo";
    const caret = text.length;
    expect(getDiffContext(text, caret)).toBeNull();
  });

  it("activates for partial prefix @diff:", () => {
    const text = "@diff:s";
    const caret = text.length;
    const ctx = getDiffContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.diffType).toBeNull(); // partial, not a full match
  });

  it("activates with caret in middle of @diff:staged", () => {
    const text = "@diff:staged";
    const caret = "@diff:st".length;
    const ctx = getDiffContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.atStart).toBe(0);
    expect(ctx?.diffType).toBe("staged"); // full token is diff:staged
  });

  it("returns null when caret is before the @", () => {
    const text = "check @diff";
    const caret = 3; // before @
    expect(getDiffContext(text, caret)).toBeNull();
  });

  it("returns null when caret is after the token with trailing text", () => {
    const text = "@diff rest";
    const caret = "@diff r".length; // past the @diff token
    expect(getDiffContext(text, caret)).toBeNull();
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
    expect(tokens[0].diffType).toBe("unstaged");
    expect(tokens[1].diffType).toBe("head");
  });

  it("handles duplicate diff tokens", () => {
    const tokens = getAllAtDiffTokens("@diff @diff");
    expect(tokens).toHaveLength(2);
  });

  it("handles newline-delimited tokens", () => {
    const tokens = getAllAtDiffTokens("@diff\n@diff:staged");
    expect(tokens).toHaveLength(2);
    expect(tokens[0].diffType).toBe("unstaged");
    expect(tokens[1].diffType).toBe("staged");
  });
});

describe("getTerminalContext", () => {
  it("detects @terminal at the caret", () => {
    const text = "check @terminal please";
    const caret = "check @terminal".length;
    const ctx = getTerminalContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.atStart).toBe(6);
    expect(ctx?.tokenEnd).toBe("check @terminal".length);
  });

  it("returns null for short prefixes like @t or @te", () => {
    expect(getTerminalContext("@t", 2)).toBeNull();
    expect(getTerminalContext("@te", 3)).toBeNull();
    expect(getTerminalContext("@ter", 4)).toBeNull();
  });

  it("activates for partial prefix @term", () => {
    const ctx = getTerminalContext("@term", 5);
    expect(ctx).not.toBeNull();
    expect(ctx?.atStart).toBe(0);
  });

  it("returns null for non-terminal @ tokens", () => {
    expect(getTerminalContext("@src/file.ts", 5)).toBeNull();
  });

  it("requires @ to be preceded by whitespace", () => {
    expect(getTerminalContext("no@terminal", "no@terminal".length)).toBeNull();
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
    expect(tokens[0].start).toBe(0);
  });
});

describe("getSelectionContext", () => {
  it("detects @selection at the caret", () => {
    const text = "check @selection please";
    const caret = "check @selection".length;
    const ctx = getSelectionContext(text, caret);
    expect(ctx).not.toBeNull();
    expect(ctx?.atStart).toBe(6);
    expect(ctx?.tokenEnd).toBe("check @selection".length);
  });

  it("returns null for short prefixes like @s or @se", () => {
    expect(getSelectionContext("@s", 2)).toBeNull();
    expect(getSelectionContext("@se", 3)).toBeNull();
    expect(getSelectionContext("@sel", 4)).toBeNull();
  });

  it("activates for partial prefix @sele", () => {
    const ctx = getSelectionContext("@sele", 5);
    expect(ctx).not.toBeNull();
    expect(ctx?.atStart).toBe(0);
  });

  it("returns null for non-selection @ tokens", () => {
    expect(getSelectionContext("@src/file.ts", 5)).toBeNull();
  });

  it("requires @ to be preceded by whitespace", () => {
    expect(getSelectionContext("no@selection", "no@selection".length)).toBeNull();
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
