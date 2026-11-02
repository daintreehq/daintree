import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CODEX_SESSION_ID = "019e59d3-9b90-77d0-ae50-03d23f9922aa";
export const CLAUDE_SESSION_ID = "5f0c2a8e-3b1d-4c7e-9a64-2d8f1e0b7c33";

/** Records shaped like a codex-cli rollout (`~/.codex/sessions/…/rollout-*.jsonl`). */
export function codexRollout(): unknown[] {
  const at = (n: number) => `2026-10-26T13:${String(n).padStart(2, "0")}:00.000Z`;
  return [
    {
      timestamp: at(0),
      type: "session_meta",
      payload: { id: CODEX_SESSION_ID, cwd: "/repo", cli_version: "0.166.0" },
    },
    {
      timestamp: at(1),
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "You are Codex, an agent." }],
      },
    },
    {
      timestamp: at(1),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo\n\nBe careful." }],
      },
    },
    {
      timestamp: at(1),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>" }],
      },
    },
    {
      timestamp: at(2),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Make the voice input start with Cmd-D." }],
      },
    },
    { timestamp: at(2), type: "event_msg", payload: { type: "user_message", message: "Make the voice input start with Cmd-D." } },
    {
      timestamp: at(3),
      type: "response_item",
      payload: { type: "reasoning", encrypted_content: "gAAAAB-secret-reasoning" },
    },
    {
      timestamp: at(3),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "rg -n voiceShortcut src" }),
        call_id: "call_1",
      },
    },
    {
      timestamp: at(4),
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_1",
        output: JSON.stringify({ output: "src/keys/voiceShortcut.ts:12: export const VOICE_KEY = 'Mod+D';" }),
      },
    },
    {
      timestamp: at(5),
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: src/keys/voiceShortcut.ts\n*** End Patch",
        call_id: "call_2",
      },
    },
    {
      timestamp: at(6),
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_2",
        output: [{ type: "input_text", text: "Success. Updated the following files: voiceShortcut.ts" }],
      },
    },
    {
      timestamp: at(7),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Cmd-D now starts dictation; the bookmark shortcut is gone." }],
      },
    },
    {
      timestamp: at(8),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Now add a test for the Linux keymap." }],
      },
    },
    {
      timestamp: at(9),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Added keymap.linux.test.ts; it fails on the shared Windows replacement." }],
      },
    },
  ];
}

/** Records shaped like a Claude Code transcript (`~/.claude/projects/…/<id>.jsonl`). */
export function claudeTranscript(): unknown[] {
  const base = { sessionId: CLAUDE_SESSION_ID, cwd: "/repo", isSidechain: false };
  const at = (n: number) => `2026-10-26T14:${String(n).padStart(2, "0")}:00.000Z`;
  return [
    { type: "summary", summary: "Earlier work", leafUuid: "x" },
    {
      ...base,
      type: "user",
      timestamp: at(0),
      message: {
        role: "user",
        content: "<command-message>work</command-message>\n<command-name>/work</command-name>\n<command-args>16097</command-args>",
      },
    },
    {
      ...base,
      type: "user",
      isMeta: true,
      timestamp: at(0),
      message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /skills/work" }] },
    },
    {
      ...base,
      type: "assistant",
      timestamp: at(1),
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private chain of thought", signature: "sig" },
          { type: "text", text: "Reading the issue first." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "gh issue view 16097" } },
        ],
      },
    },
    {
      ...base,
      type: "user",
      timestamp: at(2),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "Continue an agent's session in another agent CLI" }],
          },
        ],
      },
    },
    {
      ...base,
      isSidechain: true,
      type: "assistant",
      timestamp: at(3),
      message: { id: "msg_side", role: "assistant", content: [{ type: "text", text: "subagent chatter" }] },
    },
    {
      ...base,
      type: "user",
      timestamp: at(4),
      message: { role: "user", content: "Use FTS5 for the search, not embeddings." },
    },
    {
      ...base,
      type: "assistant",
      timestamp: at(5),
      message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "FTS5 it is: the index is" }] },
    },
    {
      ...base,
      type: "assistant",
      timestamp: at(5),
      message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "one SQLite file per session." }] },
    },
  ];
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `continue-session-${prefix}-`));
}

export function writeJsonl(path: string, records: readonly unknown[], trailingNewline = true): void {
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  writeFileSync(path, trailingNewline ? `${body}\n` : body);
}
