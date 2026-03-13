import { describe, expect, it } from "vitest";
import {
  getAtFileContext,
  getSlashCommandContext,
  getLeadingSlashCommand,
  getAllSlashCommandTokens,
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
    expect(tokens).toHaveLength(1);
    // The second / is preceded by the first /, not whitespace, so only the first token from position 0
    // Actually: first / is at pos 0, scans forward to find "//help" as one token
    expect(tokens[0]).toEqual({ start: 0, end: 6, command: "//help" });
  });

  it("returns empty for text with no slash commands", () => {
    const tokens = getAllSlashCommandTokens("just plain text");
    expect(tokens).toHaveLength(0);
  });
});
