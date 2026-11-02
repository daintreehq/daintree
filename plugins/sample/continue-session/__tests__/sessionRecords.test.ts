import { describe, expect, it } from "vitest";
import {
  parseRecord,
  slashCommandOf,
  TOOL_TEXT_MAX_CHARS,
  type RecordFragment,
} from "../main/sessionRecords.js";
import { claudeTranscript, CLAUDE_SESSION_ID, codexRollout, CODEX_SESSION_ID } from "./fixtures.js";

function fragmentsOf(agent: "codex" | "claude", records: unknown[]): RecordFragment[] {
  return records.flatMap((record) => {
    const parsed = parseRecord(agent, JSON.stringify(record));
    return parsed && !parsed.sidechain ? [...parsed.fragments] : [];
  });
}

describe("Codex rollout records", () => {
  it("names the session from session_meta", () => {
    const parsed = parseRecord("codex", JSON.stringify(codexRollout()[0]));
    expect(parsed?.sessionId).toBe(CODEX_SESSION_ID);
  });

  it("reads messages, tool calls and outputs, and skips developer text, reasoning and event copies", () => {
    const fragments = fragmentsOf("codex", codexRollout());
    expect(fragments.map((fragment) => fragment.kind)).toEqual([
      "context",
      "context",
      "prompt",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "assistant",
      "prompt",
      "assistant",
    ]);
    const text = fragments.map((fragment) => fragment.text).join("\n");
    expect(text).not.toContain("You are Codex");
    expect(text).not.toContain("secret-reasoning");
    expect(fragments[3]!.text).toBe('exec_command {"cmd":"rg -n voiceShortcut src"}');
    // A function call's JSON-wrapped output is unwrapped to its text.
    expect(fragments[4]!.text).toBe("src/keys/voiceShortcut.ts:12: export const VOICE_KEY = 'Mod+D';");
    expect(fragments[6]!.text).toContain("Success. Updated the following files");
  });

  it("caps a huge tool output for the index", () => {
    const output = "z ".repeat(TOOL_TEXT_MAX_CHARS);
    const parsed = parseRecord(
      "codex",
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output } })
    );
    const text = parsed!.fragments[0]!.text;
    expect(text.length).toBeLessThan(TOOL_TEXT_MAX_CHARS + 100);
    expect(text).toContain("[… truncated for the index]");
  });

  it("answers null for a line that isn't a JSON object", () => {
    expect(parseRecord("codex", "{not json")).toBeNull();
    expect(parseRecord("codex", "[1,2]")).toBeNull();
  });
});

describe("Claude Code transcript records", () => {
  it("reads prompts, replies, tool calls and results; skips thinking, meta-free sidechains and summaries", () => {
    const fragments = fragmentsOf("claude", claudeTranscript());
    expect(fragments.map((fragment) => fragment.kind)).toEqual([
      "context",
      "context",
      "assistant",
      "tool_call",
      "tool_result",
      "prompt",
      "assistant",
      "assistant",
    ]);
    const text = fragments.map((fragment) => fragment.text).join("\n");
    expect(text).not.toContain("private chain of thought");
    expect(text).not.toContain("subagent chatter");
    expect(fragments[3]!.text).toBe('Bash {"command":"gh issue view 16097"}');
    expect(fragments[6]).toMatchObject({ messageKey: "msg_2" });
  });

  it("carries the session id on every record and flags sidechains", () => {
    const records = claudeTranscript();
    expect(parseRecord("claude", JSON.stringify(records[1]))?.sessionId).toBe(CLAUDE_SESSION_ID);
    expect(parseRecord("claude", JSON.stringify(records[5]))?.sidechain).toBe(true);
  });

  it("reads a slash command's expansion as the command the user typed", () => {
    expect(
      slashCommandOf(
        "<command-message>work</command-message>\n<command-name>/work</command-name>\n<command-args>16097</command-args>"
      )
    ).toBe("/work 16097");
    expect(slashCommandOf("<command-name>/clear</command-name><command-args></command-args>")).toBe(
      "/clear"
    );
    expect(slashCommandOf("plain text")).toBeNull();
  });
});
