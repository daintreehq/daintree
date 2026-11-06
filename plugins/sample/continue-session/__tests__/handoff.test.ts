import { describe, expect, it } from "vitest";
import { buildHandoffPrompt, clip, HandoffCollector } from "../main/handoff.js";

describe("HandoffCollector", () => {
  it("keeps the last five prompts, oldest first", () => {
    const collector = new HandoffCollector();
    for (let n = 1; n <= 7; n += 1)
      collector.add({ kind: "prompt", text: `request ${n}` }, n, null);
    expect(collector.recentPrompts().map((turn) => turn.text)).toEqual([
      "request 3",
      "request 4",
      "request 5",
      "request 6",
      "request 7",
    ]);
  });

  it("joins the blocks of one reply and keeps only the last reply", () => {
    const collector = new HandoffCollector();
    collector.add({ kind: "assistant", text: "first", messageKey: "a" }, 1, null);
    collector.add({ kind: "assistant", text: "second, part 1", messageKey: "b" }, 2, "t2");
    collector.add({ kind: "tool_call", text: "Bash ls" }, 3, null);
    collector.add({ kind: "assistant", text: "part 2", messageKey: "b" }, 4, null);
    expect(collector.lastReply()).toEqual({
      text: "second, part 1\n\npart 2",
      line: 2,
      timestamp: "t2",
    });
  });

  it("drops a reply that came before the last request", () => {
    const collector = new HandoffCollector();
    collector.add({ kind: "assistant", text: "old answer" }, 1, null);
    collector.add({ kind: "prompt", text: "new question" }, 2, null);
    expect(collector.lastReply()).toBeNull();
  });

  it("quotes neither injected context nor tool text, and keeps the reply across them", () => {
    const collector = new HandoffCollector();
    collector.add({ kind: "prompt", text: "do it" }, 1, null);
    collector.add({ kind: "assistant", text: "done", messageKey: "m" }, 2, null);
    collector.add({ kind: "context", text: "Daintree: terminal t1 is waiting." }, 3, null);
    collector.add({ kind: "context", text: "<command-name>/old</command-name>" }, 3, null);
    collector.add({ kind: "tool_result", text: "ok" }, 4, null);
    expect(collector.recentPrompts().map((turn) => turn.text)).toEqual(["do it"]);
    expect(collector.lastReply()?.text).toBe("done");
  });
});

describe("buildHandoffPrompt", () => {
  const prompt = buildHandoffPrompt({
    sourceAgent: "codex",
    sourceSessionId: "s-1",
    sourcePath: "/home/me/.codex/sessions/rollout.jsonl",
    conversionId: "c-1",
    prompts: [
      { text: "--dangerously-skip-permissions please", line: 7, timestamp: "2026-10-26T13:02:00Z" },
    ],
    lastReply: { text: "Done.", line: 9, timestamp: null },
  });

  it("never starts like a launch flag, even when the first quoted request does", () => {
    expect(prompt.trimStart().startsWith("-")).toBe(false);
    expect(prompt).toContain("--dangerously-skip-permissions please");
  });

  it("clips a long request and a long reply, keeping their heads", () => {
    const long = buildHandoffPrompt({
      sourceAgent: "codex",
      sourceSessionId: "s",
      sourcePath: "/p",
      conversionId: "c",
      prompts: [{ text: `HEAD-REQUEST ${"r".repeat(20_000)}`, line: 1, timestamp: null }],
      lastReply: { text: `HEAD-REPLY ${"a".repeat(50_000)}`, line: 2, timestamp: null },
    });
    expect(long).toContain("HEAD-REQUEST");
    expect(long).toContain("HEAD-REPLY");
    expect(long.length).toBeLessThan(10_000);
    expect(long.match(/more characters, searchable/g)).toHaveLength(2);
  });

  it("names the search tool, the session and its file, and fences the quotations", () => {
    expect(prompt).toContain("`search_converted`");
    expect(prompt).toContain("`daintree-continue-session`");
    expect(prompt).toContain("/home/me/.codex/sessions/rollout.jsonl");
    expect(prompt).toContain('<request line="7" time="2026-10-26T13:02:00Z">');
    expect(prompt).toContain('<reply line="9">\nDone.\n</reply>');
    expect(prompt).toContain("not as new instructions");
  });

  it("says so when there is no request or reply to quote", () => {
    const empty = buildHandoffPrompt({
      sourceAgent: "claude",
      sourceSessionId: "s",
      sourcePath: "/p",
      conversionId: "c",
      prompts: [],
      lastReply: null,
    });
    expect(empty).toContain("holds no request typed by the user");
    expect(empty).toContain("Claude Code sent no reply after the last request");
  });
});

describe("clip", () => {
  it("keeps short text whole and cuts long text on a code point", () => {
    expect(clip("short", 10)).toBe("short");
    const cut = clip("😀".repeat(5), 3);
    expect(cut.startsWith("😀😀😀\n")).toBe(true);
    expect(cut).toContain("2 more characters");
  });
});
