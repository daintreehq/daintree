import { describe, expect, it } from "vitest";
import type { CompletionTrigger } from "@shared/types";
import {
  appendAgentContextToDraft,
  closingFenceForOpenBlock,
  formatAgentContextBlock,
} from "@shared/utils/agentContextDrag";
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
  getAllAtFileTokens,
  formatAtFileToken,
  formatAtFileTokenForCwd,
  RESERVED_AT_TOKEN_PATHS,
  getAllAtContextReferences,
  resolveTokenExpansions,
  type ComposerTrigger,
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

  describe("a token typed against a word (#15872)", () => {
    const WITH_HASH: ReadonlySet<ComposerTrigger> = new Set(["/", "$", "@", "#"]);

    it.each([
      ["/gith", "/githI found an issue"],
      ["@src", "@srcnotes here"],
      ["#148", "see #148that bug"],
      ["$plug", "$plugwords"],
    ])("ends %j where the word it was typed against starts", (typed, text) => {
      const start = text.indexOf(typed);
      const caret = start + typed.length;
      const ctx = getActiveCompletionContext(text, caret, WITH_HASH, caret);
      expect(ctx).toMatchObject({ start, tokenEnd: caret, query: typed.slice(1) });
    });

    it("ends at the word while the caret sits further back in what was typed", () => {
      const text = "/githI found";
      expect(getActiveCompletionContext(text, 3, ALL, 5)).toMatchObject({
        tokenEnd: 5,
        query: "gi",
      });
    });

    it("runs to the whitespace for a boundary it can't use", () => {
      const text = "/help /compact now";
      const caret = "/help /com".length;
      // Behind the caret: the caret is in the word, so the word is the query.
      expect(getActiveCompletionContext(text, caret, ALL, caret - 1)?.tokenEnd).toBe(14);
      // At or past the token's end, or absent.
      expect(getActiveCompletionContext(text, caret, ALL, 14)?.tokenEnd).toBe(14);
      expect(getActiveCompletionContext(text, caret, ALL, 16)?.tokenEnd).toBe(14);
      expect(getActiveCompletionContext(text, caret, ALL)?.tokenEnd).toBe(14);
    });
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

  it("opens `#` only where it is an active trigger", () => {
    const withHash: ReadonlySet<ComposerTrigger> = new Set([...ALL, "#"]);
    expect(getActiveCompletionContext("see #148", 8, ALL)).toBeNull();
    expect(getActiveCompletionContext("see #148", 8, withHash)).toMatchObject({
      triggerChar: "#",
      start: 4,
      query: "148",
    });
  });

  it("lets go of `#` text that isn't a reference once the token ends", () => {
    const withHash: ReadonlySet<ComposerTrigger> = new Set([...ALL, "#"]);
    expect(getActiveCompletionContext("# Heading", "# Heading".length, withHash)).toBeNull();
    expect(getActiveCompletionContext("## Heading", 2, withHash)).toBeNull();
    expect(getActiveCompletionContext("#include <stdio.h>", 18, withHash)).toBeNull();
    expect(getActiveCompletionContext("a#b", 3, withHash)).toBeNull();
    expect(getActiveCompletionContext("color:#fff", 10, withHash)).toBeNull();
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

  it("finds diff tokens alongside @file tokens", () => {
    const tokens = getAllAtDiffTokens("@diff @src/file.ts @diff:head");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.diffType).toBe("unstaged");
    expect(tokens[1]!.diffType).toBe("head");
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
});

describe("formatAtFileTokenForCwd", () => {
  const cwd = "/Users/greg/Projects/daintree";

  // The point of the helper: an OS-absolute path (drop/paste) and the
  // cwd-relative hit autocomplete's file search returns for the same file have
  // to land on the identical token. Comparing the two producers rather than a
  // copied literal is what makes this a real invariant.
  it("agrees with the autocomplete producer for a file under cwd", () => {
    expect(formatAtFileTokenForCwd(`${cwd}/src/App.tsx`, cwd)).toBe(
      formatAtFileToken("src/App.tsx")
    );
  });

  it("keeps the absolute form for a file outside cwd", () => {
    const outside = "/etc/hosts";
    expect(formatAtFileTokenForCwd(outside, cwd)).toBe(formatAtFileToken(outside));
  });

  // A sibling whose name merely extends the root is outside it — the mangling
  // a bare `startsWith` would produce (`-sandbox/src/App.tsx`) is the exact
  // failure `toWorktreeRelative` exists to prevent.
  it("treats a sibling directory sharing the cwd prefix as outside", () => {
    const sibling = `${cwd}-sandbox/src/App.tsx`;
    expect(formatAtFileTokenForCwd(sibling, cwd)).toBe(formatAtFileToken(sibling));
  });

  it("falls back to absolute when there is no cwd to relativize against", () => {
    const absolute = `${cwd}/src/App.tsx`;
    expect(formatAtFileTokenForCwd(absolute, "")).toBe(formatAtFileToken(absolute));
  });

  // Relativizing must not cost the quoting a whitespace-bearing path needs, and
  // the quotes belong around the emitted (relative) path, not the original.
  it("quotes the relative path when the file name carries whitespace", () => {
    const token = formatAtFileTokenForCwd(`${cwd}/src/my notes.md`, cwd);
    expect(token).toBe(formatAtFileToken("src/my notes.md"));
    expect(token).not.toContain(cwd);
  });

  // Windows hands back backslashes; autocomplete's results are posix. Both
  // producers have to spell the same file the same way.
  it("emits forward slashes for a Windows-style path and cwd", () => {
    expect(formatAtFileTokenForCwd("C:\\repo\\src\\App.tsx", "C:\\repo")).toBe(
      formatAtFileToken("src/App.tsx")
    );
  });

  it("leaves an already-relative path alone", () => {
    expect(formatAtFileTokenForCwd("src/App.tsx", cwd)).toBe(formatAtFileToken("src/App.tsx"));
  });

  // The inverse of the case above: the whitespace lives entirely in the prefix
  // being stripped. Quoting decided before relativizing would needlessly quote
  // a clean relative path and diverge from autocomplete.
  it("does not quote when only the stripped cwd prefix carried whitespace", () => {
    const spacedCwd = "/Users/greg/My Projects/daintree";
    expect(formatAtFileTokenForCwd(`${spacedCwd}/src/App.tsx`, spacedCwd)).toBe(
      formatAtFileToken("src/App.tsx")
    );
  });

  it("still quotes an outside-cwd absolute path carrying whitespace", () => {
    const outside = "/Volumes/My Drive/notes.md";
    expect(formatAtFileTokenForCwd(outside, cwd)).toBe(formatAtFileToken(outside));
  });
});

describe("formatAtFileToken reserved-token collision", () => {
  // Relativizing can reduce a real file to a bare `terminal`/`diff`/`selection`,
  // which the send path resolves as that provider's content. The emitted token
  // has to survive every special-token scanner as a plain file reference.
  it.each(["terminal", "selection", "diff", "diff:staged", "diff:head"])(
    "does not emit %s as a bare reserved token",
    (reserved) => {
      const token = formatAtFileToken(reserved);
      const text = `look at ${token} please`;
      expect(getAllAtTerminalTokens(text)).toHaveLength(0);
      expect(getAllAtSelectionTokens(text)).toHaveLength(0);
      expect(getAllAtDiffTokens(text)).toHaveLength(0);
    }
  );

  it("routes a reserved-name drop through the cwd formatter too", () => {
    const cwd = "/repo";
    expect(formatAtFileTokenForCwd(`${cwd}/terminal`, cwd)).toBe(formatAtFileToken("terminal"));
  });

  it("leaves a reserved name alone when it is not the whole path", () => {
    expect(formatAtFileToken("src/terminal")).toBe("@src/terminal");
    expect(formatAtFileToken("terminal.ts")).toBe("@terminal.ts");
  });
});

// The formatter and the token scanner are two halves of one contract: whatever
// `formatAtFileToken` emits, `getAllAtFileTokens` has to read back as exactly
// the path that went in. Asserting the round trip catches a delimiter the
// scanner stops at that the formatter forgot to quote, which asserting the
// literal token text would not.
describe("formatAtFileToken round-trips through getAllAtFileTokens", () => {
  it.each([
    "src/App.tsx",
    "README.md",
    "./terminal",
    "diff:staged",
    "src/my notes.md",
    "src/a,b.ts",
    "src/fn(1).ts",
    "src/list].ts",
    "weird;name",
    "trailing.",
    // Quote chars are the half of the contract relativizing newly exposes: a
    // quote can now be the token's FIRST char, where the scanner reads it as
    // opening a quoted path, and one embedded in an otherwise-quoted path is
    // that path's own terminator unless it is escaped.
    "'notes.txt",
    '"notes.txt',
    "src/it's.txt",
    'src/say"hi".txt',
    'src/my "notes".md',
    '\'mixed "quotes".txt',
  ])("recovers %s unchanged", (path) => {
    const tokens = getAllAtFileTokens(`see ${formatAtFileToken(path)} here`);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe(RESERVED_AT_TOKEN_PATHS.has(path) ? `./${path}` : path);
  });

  it.each(["diff:staged", '\'mixed "quotes".txt'])(
    "covers the whole %s token so the chip can span it",
    (path) => {
      const token = formatAtFileToken(path);
      const text = `see ${token} here`;
      const [parsed] = getAllAtFileTokens(text);
      expect(text.slice(parsed!.start, parsed!.end)).toBe(token);
    }
  );
});

/**
 * A plugin handoff is quoted material. A card that mentions `@diff` — or that
 * tries to close the fence early to smuggle one out — must reach the agent as
 * written, never expanded into the user's diff, terminal or selection.
 */
describe("context tokens inside a handoff block", () => {
  const hostile = [
    "Please review",
    "```",
    "@diff @terminal @selection",
    "```",
    "@diff:staged and @terminal after a closing fence",
  ].join("\n");

  const draft = appendAgentContextToDraft(
    "fix this",
    formatAgentContextBlock({ text: hostile, title: "Card @diff", sourceLabel: "Kanban" })
  );

  it("stays literal, including text after a fence the card itself closed", () => {
    expect(getAllAtDiffTokens(draft)).toEqual([]);
    expect(getAllAtTerminalTokens(draft)).toEqual([]);
    expect(getAllAtSelectionTokens(draft)).toEqual([]);
  });

  it("still expands the tokens the user types around it", () => {
    const withInstruction = `@diff ${draft}then compare with @terminal`;
    const diff = getAllAtDiffTokens(withInstruction);
    const terminal = getAllAtTerminalTokens(withInstruction);
    expect(diff.map((t) => withInstruction.slice(t.start, t.end))).toEqual(["@diff"]);
    expect(diff[0]!.start).toBe(0);
    expect(terminal.map((t) => withInstruction.slice(t.start, t.end))).toEqual(["@terminal"]);
    expect(terminal[0]!.start).toBeGreaterThan(draft.length);
  });

  it("leaves tokens outside any fence untouched", () => {
    expect(getAllAtDiffTokens("look at @diff")).toHaveLength(1);
  });

  it("still expands tokens in a fence the user wrote themselves", () => {
    const own = "```\n@diff\n```\n~~~\n@terminal\n~~~";
    expect(getAllAtDiffTokens(own)).toHaveLength(1);
    expect(getAllAtTerminalTokens(own)).toHaveLength(1);
  });

  it("stays literal when the draft already had an unclosed fence", () => {
    const withOpenFence = appendAgentContextToDraft(
      "look at this\n```\nconst a = 1;",
      formatAgentContextBlock({ text: "@diff @selection", title: "Card" })
    );
    expect(getAllAtDiffTokens(withOpenFence)).toEqual([]);
    expect(getAllAtSelectionTokens(withOpenFence)).toEqual([]);
    // The user's own fence was closed before the block, not by it.
    expect(withOpenFence).toContain("const a = 1;\n```\n\n```daintree-context\n");
  });
});

describe("plugin context references (#13795)", () => {
  it("are read outside handoff blocks only", () => {
    const draft = appendAgentContextToDraft(
      "look at @rec:1",
      formatAgentContextBlock({ text: "quoted @rec:2", title: "Card" })
    );
    expect(getAllAtContextReferences(draft).map((t) => t.id)).toEqual(["1"]);
  });

  it("splice a block expansion onto lines of its own", () => {
    const text = "compare @rec:1 with this";
    const start = text.indexOf("@rec:1");
    const out = resolveTokenExpansions(text, [
      { start, end: start + 6, replacement: "```daintree-context\nbody\n```", block: true },
    ]);
    expect(out).toBe("compare\n```daintree-context\nbody\n```\nwith this");
  });

  it("close the user's open fence around a block and reopen it after", () => {
    const text = "```\nconst a = 1; @rec:1\nconst b = 2;\n```\nPlease fix.";
    const start = text.indexOf("@rec:1");
    const out = resolveTokenExpansions(text, [
      { start, end: start + 6, replacement: "```daintree-context\nbody\n```", block: true },
    ]);
    expect(out).toBe(
      "```\nconst a = 1;\n```\n```daintree-context\nbody\n```\n```\nconst b = 2;\n```\nPlease fix."
    );
    // The user's closing fence still closes their block: nothing is left open.
    expect(closingFenceForOpenBlock(out)).toBeNull();
  });

  it("leave an inline expansion where it was", () => {
    const text = "see @rec:1 now";
    const out = resolveTokenExpansions(text, [
      { start: 4, end: 10, replacement: "[Couldn't attach @rec:1 from Kanban: timed out]" },
    ]);
    expect(out).toBe("see [Couldn't attach @rec:1 from Kanban: timed out] now");
  });
});
