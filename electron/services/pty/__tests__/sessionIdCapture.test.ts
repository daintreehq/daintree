import { describe, expect, it } from "vitest";
import { createSessionIdMatcher } from "../sessionIdCapture.js";
import { getAgentConfig } from "../../../../shared/config/agentRegistry.js";

/**
 * Read Codex's real pattern rather than copying it: a matcher that only works
 * against a hand-written regex would pass here and fail in production.
 */
function codexPattern(): string {
  const resume = getAgentConfig("codex")?.resume;
  if (resume?.kind !== "session-id" || !resume.sessionIdPattern) {
    throw new Error("codex must declare a sessionIdPattern");
  }
  return resume.sessionIdPattern;
}

const PATTERN = codexPattern();
const ID = "0199f8c1-2b4d-7e3a-9f10-5c6d7e8f9a0b";

function match(
  raw: string,
  options: Parameters<NonNullable<ReturnType<typeof createSessionIdMatcher>>>[1]
) {
  const matcher = createSessionIdMatcher(PATTERN);
  if (!matcher) throw new Error("matcher must compile");
  return matcher(raw, options);
}

describe("createSessionIdMatcher", () => {
  it("returns null when the agent declares no pattern", () => {
    expect(createSessionIdMatcher(undefined)).toBeNull();
    expect(createSessionIdMatcher("")).toBeNull();
  });

  it("matches through ANSI decoration", () => {
    const raw = `\x1b[2m\x1b[38;5;245mTo resume, run codex resume ${ID}\x1b[0m\n`;
    expect(match(raw, { occurrence: "last", boundary: "eof" })).toEqual({
      kind: "match",
      sessionId: ID,
    });
  });

  it("takes the first occurrence in first mode and the last in last mode", () => {
    const raw = `codex resume aaa-111\nsomething else\ncodex resume ${ID}\n`;
    expect(match(raw, { occurrence: "first", boundary: "eof" })).toEqual({
      kind: "match",
      sessionId: "aaa-111",
    });
    expect(match(raw, { occurrence: "last", boundary: "eof" })).toEqual({
      kind: "match",
      sessionId: ID,
    });
  });

  it("holds a stream match that ends at the tail until a boundary arrives", () => {
    const truncated = `codex resume ${ID.slice(0, 15)}`;
    expect(match(truncated, { occurrence: "first", boundary: "stream" })).toEqual({
      kind: "needs-boundary",
    });
    expect(match(`${truncated}\n`, { occurrence: "first", boundary: "stream" })).toEqual({
      kind: "match",
      sessionId: ID.slice(0, 15),
    });
  });

  it("accepts a match ending exactly at the tail in eof mode", () => {
    expect(match(`codex resume ${ID}`, { occurrence: "last", boundary: "eof" })).toEqual({
      kind: "match",
      sessionId: ID,
    });
  });

  it("never trades an unterminated newest match for an older complete one", () => {
    const raw = `codex resume older-session-id\ncodex resume ${ID.slice(0, 20)}`;
    expect(match(raw, { occurrence: "last", boundary: "stream" })).toEqual({
      kind: "needs-boundary",
    });
  });

  it("returns none when nothing matches", () => {
    expect(match("$ ls -la\ntotal 0\n", { occurrence: "last", boundary: "eof" })).toEqual({
      kind: "none",
    });
  });

  describe("tailLines window", () => {
    it("rejects a hint pushed beyond the window by later output", () => {
      const raw = [
        `I ran it with codex resume ${ID} and it worked`,
        "$ npm test",
        "  ok 1 - first",
        "  ok 2 - second",
        "  ok 3 - third",
        "$ ",
      ].join("\n");
      expect(match(raw, { occurrence: "last", boundary: "eof", tailLines: 4 })).toEqual({
        kind: "none",
      });
      // The same text with no window restriction still matches, proving the
      // window — not the regex — is what rejected it.
      expect(match(raw, { occurrence: "last", boundary: "eof" })).toEqual({
        kind: "match",
        sessionId: ID,
      });
    });

    it("accepts a hint still inside the window, with the shell prompt after it", () => {
      const raw = [
        "some earlier conversation output",
        "and more of it",
        "",
        `To continue this session, run codex resume ${ID}`,
        "",
        "user@host project % ",
      ].join("\n");
      expect(match(raw, { occurrence: "last", boundary: "stream", tailLines: 4 })).toEqual({
        kind: "match",
        sessionId: ID,
      });
    });

    it("does not spend the window budget on blank lines", () => {
      const raw = [`codex resume ${ID}`, "", "", "", "", "$ "].join("\n");
      expect(match(raw, { occurrence: "last", boundary: "stream", tailLines: 4 })).toEqual({
        kind: "match",
        sessionId: ID,
      });
    });

    it("treats CRLF output as line-separated", () => {
      const raw = `noise\r\nmore noise\r\ncodex resume ${ID}\r\n$ \r\n`;
      expect(match(raw, { occurrence: "last", boundary: "stream", tailLines: 2 })).toEqual({
        kind: "match",
        sessionId: ID,
      });
    });
  });

  it("does not leak regex lastIndex between calls", () => {
    const matcher = createSessionIdMatcher(PATTERN);
    if (!matcher) throw new Error("matcher must compile");
    const raw = `codex resume ${ID}\n`;
    const first = matcher(raw, { occurrence: "last", boundary: "eof" });
    const second = matcher(raw, { occurrence: "last", boundary: "eof" });
    expect(second).toEqual(first);
    expect(second).toEqual({ kind: "match", sessionId: ID });
  });
});
