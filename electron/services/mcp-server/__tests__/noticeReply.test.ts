import { describe, expect, it } from "vitest";
import { extractNoticeReply, extractReply } from "../noticeReply.js";

describe("extracting a reply", () => {
  it("ends the quote at the agent's handback marker, dropping the chrome below", () => {
    const screen = [
      "› Tell me a fact. End with: DAINTREE-DONE-abc123: <summary> END-abc123",
      "• Honey never spoils.",
      "DAINTREE-DONE-abc123: gave a fact END-abc123",
      "",
      "› Ask Codex to do anything",
      "  gpt-5 · 90% context left",
    ].join("\n");
    expect(extractNoticeReply(screen, 40, true)?.text).toBe(
      [
        "› Tell me a fact. End with: DAINTREE-DONE-abc123: <summary> END-abc123",
        "• Honey never spoils.",
        "DAINTREE-DONE-abc123: gave a fact END-abc123",
      ].join("\n")
    );
  });

  it("never cuts at an echoed instruction that wrapped before its END", () => {
    const screen = [
      "  message with this line exactly, replacing <summary> with a one-line",
      "  plain-text summary (it may be empty): DAINTREE-DONE-abc123: <summary>",
      "  END-abc123",
      "Fact: honey never spoils.",
      "DAINTREE-DONE-abc123: gave a fact END-abc123",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(extractNoticeReply(screen, 40, true)?.text.endsWith("gave a fact END-abc123")).toBe(
      true
    );
    expect(extractNoticeReply(screen.split("\n").slice(0, 4).join("\n"), 40, true)?.text).toContain(
      "Fact: honey never spoils."
    );
  });

  it("never cuts at the echoed instruction when the agent printed no marker", () => {
    const screen = [
      "› Tell me a fact. End with: DAINTREE-DONE-abc123: <summary> END-abc123",
      "• Honey never spoils.",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(extractNoticeReply(screen, 40, true)?.text).toContain("Ask Codex to do anything");
  });

  // Grok 4.7 in a 70x90 pane: the transcript is pinned to the top, a
  // scrollbar runs down every empty row, and the marker wrapped at `END-`.
  const scrollbar = `${" ".repeat(68)}█`;
  const tallGrokScreen = [
    "  develop ~/P/Daintree/daintree             35K / 500K │ [Dashboard]",
    "     ❯ Peer vote: Among the other agents' entries,         7:42 PM",
    "       choose the single best fact. A: The Lycurgus Cup",
    "     ◆ Thought for 4.8s",
    "     A — the Lycurgus Cup is a specific object with a      7:43 PM",
    "     precise, surprising mechanism.",
    "     Runner-up: C",
    "     DAINTREE-DONE-z8zq5c: Voted A, runner-up C. END-",
    "     z8zq5c",
    `${"     Worked for 6.9s".padEnd(68)}█`,
    ...Array.from({ length: 68 }, () => scrollbar),
    "  Help improve Grok                               [Opt out] [Opt in]",
    "  ╭────────────────────────────────────────────────────────────────╮",
    "  │ ❯                                                              │",
    "  ╰──────────────────────────── Grok 4.7 (xhigh) · always-approve ─╯",
    "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
  ].join("\n");

  it("finds a marker far above the composer and wrapped at its hyphen", () => {
    const extracted = extractReply(tallGrokScreen, 40, true);
    expect(extracted.reachedHandback).toBe(true);
    expect(extracted.reply?.text).toContain("A — the Lycurgus Cup");
    expect(extracted.reply?.text.endsWith("     z8zq5c")).toBe(true);
    expect(extracted.reply?.text).not.toContain("█");
  });

  it("collapses a scrollbar column so a settled quote still reaches the reply", () => {
    const extracted = extractReply(tallGrokScreen, 40, false);
    expect(extracted.reachedHandback).toBe(false);
    expect(extracted.reply?.text).toContain("Voted A, runner-up C.");
    expect(extracted.reply?.text).toContain("Help improve Grok");
    expect(extracted.reply?.text).not.toContain("█");
  });

  it("never ends at an earlier turn's marker when the one observed is not on screen", () => {
    const screen = [
      "DAINTREE-DONE-aaaaaa: first answer END-aaaaaa",
      "• Second answer, still printing",
      "› Ask",
    ].join("\n");
    const observed = { message: "second answer", observedAt: 0, truncated: false };
    const extracted = extractReply(screen, 40, observed);
    expect(extracted.reachedHandback).toBe(false);
    expect(extracted.reply?.text).toContain("Second answer");
  });

  it("ends at the reply's marker, not a spinner's still showing one below it", () => {
    const screen = [
      "A: the Lycurgus Cup.",
      "DAINTREE-DONE-abc123: Voted A END-abc123",
      "⣟  DAINTREE-DONE-abc123: Weighing the entries END-abc123",
      "esc to cancel",
    ].join("\n");
    const extracted = extractReply(screen, 40, true);
    expect(extracted.reachedHandback).toBe(true);
    expect(extracted.reply?.text.endsWith("Voted A END-abc123")).toBe(true);
  });

  it("tells two turns with the same summary apart by the marker's code", () => {
    const screen = [
      "• First answer.",
      "DAINTREE-DONE-aaaaaa: Done. END-aaaaaa",
      "• Second answer, still on its way to the screen",
      "› Ask",
    ].join("\n");
    const extracted = extractReply(screen, 40, { message: "Done.", code: "bbbbbb" });
    expect(extracted.reachedHandback).toBe(false);
    expect(extracted.reply?.text).toContain("Second answer");
  });

  it("ends at the later of two identical pairs", () => {
    const screen = [
      "DAINTREE-DONE-abc123: Done. END-abc123",
      "• Repeated the summary after a redraw.",
      "DAINTREE-DONE-abc123: Done. END-abc123",
      "› Ask",
    ].join("\n");
    const extracted = extractReply(screen, 40, { message: "Done.", code: "abc123" });
    expect(
      extracted.reply?.text.endsWith(
        "Repeated the summary after a redraw.\nDAINTREE-DONE-abc123: Done. END-abc123"
      )
    ).toBe(true);
  });

  it("ends at the pair's own closing marker, not a stray one printed below it", () => {
    const screen = [
      "DAINTREE-DONE-abc123: Done. END-abc123",
      "grep output: END-abc123",
      "› Ask",
    ].join("\n");
    const extracted = extractReply(screen, 40, { message: "Done.", code: "abc123" });
    expect(extracted.reachedHandback).toBe(true);
    expect(extracted.reply?.text).toBe("DAINTREE-DONE-abc123: Done. END-abc123");
  });

  it("keeps block glyphs that line up in a column without forming a run", () => {
    const bar = (label: string) => `${label.padEnd(20)}█`;
    const screen = [bar("alpha"), "", bar("beta"), "", bar("gamma")].join("\n");
    expect(extractReply(screen, 40, false).reply?.text.match(/█/g)).toHaveLength(3);
  });

  it("keeps a lone block glyph that is part of the reply", () => {
    const extracted = extractReply("Progress:\n  █\nDone.", 40, false);
    expect(extracted.reply?.text).toBe("Progress:\n  █\nDone.");
  });

  it("says when no marker was found for the quote to end at", () => {
    const screen = "• Honey never spoils.\n› Ask Codex to do anything";
    expect(extractReply(screen, 40, true)).toMatchObject({ reachedHandback: false });
  });

  it("caps a long reply, keeping its newest whole lines", () => {
    const screen = Array.from({ length: 150 }, (_, i) => `${i} ${"y".repeat(60)}`).join("\n");
    const reply = extractNoticeReply(screen, 150, false);
    expect(reply?.truncated).toBe(true);
    expect(reply!.text.length).toBeLessThanOrEqual(6_000);
    expect(reply!.text.startsWith(" ")).toBe(false);
    expect(reply!.text.endsWith(`149 ${"y".repeat(60)}`)).toBe(true);
  });

  it("drops terminal-query replies a CLI echoed as caret text", () => {
    const screen = "^[_Gi=31;OK^[\\^[[?62;4;9;22cAccessing workspace:\n> Yes, I trust this folder";
    expect(extractNoticeReply(screen, 40, false)?.text).toBe(
      "Accessing workspace:\n> Yes, I trust this folder"
    );
  });

  it("returns nothing for a blank screen or zero lines", () => {
    expect(extractNoticeReply("\n\n  \n", 40, false)).toBeNull();
    expect(extractNoticeReply("text", 0, false)).toBeNull();
  });
});
