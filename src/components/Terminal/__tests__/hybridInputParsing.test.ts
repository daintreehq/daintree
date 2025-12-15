import { describe, expect, it } from "vitest";
import { getAtFileContext, getSlashCommandContext } from "../hybridInputParsing";

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
  it("detects a slash command only at start of input", () => {
    expect(getSlashCommandContext("echo /help", "echo /h".length)).toBeNull();
    expect(getSlashCommandContext("/help", 2)?.query).toBe("/h");
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
});
