import { describe, expect, it, vi } from "vitest";

const readAgentReply = vi.hoisted(() => vi.fn());
vi.mock("../voiceAgentReply.js", () => ({ readAgentReplyForCorrection: readAgentReply }));

import {
  MAX_CORRECTION_TERMINAL_CHARS,
  MAX_CORRECTION_TERMINAL_LINES,
  boundTerminalOutput,
  readTerminalContextForCorrection,
  readTerminalOutputForCorrection,
} from "../voiceTerminalContext.js";
import type { PtyClient } from "../PtyClient.js";
import { CURSOR_GAP } from "../voiceKeytermSecrets.js";

const clientWith = (getTerminalSnapshot: unknown) =>
  ({ getTerminalSnapshot }) as unknown as PtyClient;

describe("boundTerminalOutput", () => {
  it("keeps the newest lines within the line bound", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const out = boundTerminalOutput(lines)!.split("\n");
    expect(out).toHaveLength(MAX_CORRECTION_TERMINAL_LINES);
    expect(out[out.length - 1]).toBe("line 399");
  });

  it("keeps the newest text within the character cap", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}: ${"x".repeat(250)}`);
    const out = boundTerminalOutput(lines)!;
    expect(out.length).toBeLessThanOrEqual(MAX_CORRECTION_TERMINAL_CHARS);
    expect(out.endsWith(lines[99]!)).toBe(true);
    expect(out).not.toContain(lines[0]!);
  });

  it("cuts a very long line", () => {
    const out = boundTerminalOutput(["y".repeat(5000)])!;
    expect(out.length).toBeLessThan(400);
  });

  it("drops a line holding a credential and folds the blank run it leaves", () => {
    const secret = `ghp_${"a1B2".repeat(9)}`;
    const out = boundTerminalOutput(["before", `TOKEN=${secret}`, "", "", "after"])!;
    expect(out).not.toContain(secret);
    expect(out).toBe("before\n\nafter");
  });

  it("redacts a credential split by colour codes", () => {
    const out = boundTerminalOutput(["\x1b[36mpassword\x1b[39m: hunter2", "", "kept"])!;
    expect(out).not.toContain("hunter2");
    expect(out).toBe("kept");
  });

  it("redacts a numeric password assigned or passed as a flag", () => {
    const out = boundTerminalOutput([
      "PGPASSWORD=123456",
      "",
      "mysql --password 123456 -u root",
      "",
      "kept",
    ])!;
    expect(out).not.toContain("123456");
    expect(out).toBe("kept");
  });

  it("keeps words a TUI separated with cursor-forward apart (#14886)", () => {
    const row =
      "\x1b[1C2.\x1b[1CSonnet\x1b[1C5\x1b[3CEfficient\x1b[1Cfor\x1b[1Croutine\x1b[1Ctasks";
    const out = boundTerminalOutput([row])!;
    expect(out).toContain("Sonnet 5");
    expect(out).toContain("Efficient for routine tasks");
    expect(out).not.toMatch(/5Efficient/);
  });

  it("keeps a repaint's fragments from joining across the rows it jumps", () => {
    const out = boundTerminalOutput(["\x1b[3;1HModel\x1b[1Cpicker\x1b[5;3HSonnet\x1b[2AOpus"])!;
    expect(out).toContain("Model picker");
    expect(out).not.toMatch(/pickerSonnet|SonnetOpus/);
  });

  it("drops a key a repaint split into pieces too short to read as one", () => {
    const out = boundTerminalOutput(["key aB3xK9mQ7z\x1b[1CZt7WpL2nQ4 done", "", "kept"])!;
    expect(out).toBe("kept");
  });

  it("drops a hex key a repaint split", () => {
    const out = boundTerminalOutput(["DG=7c26\x1b[1C52f8\x1b[1C3d4d\x1b[1C0fff", "", "kept"])!;
    expect(out).toBe("kept");
  });

  it("drops a split hex key that has an intact copy on the same line", () => {
    const row = "DG=7c26\x1b[1C52f8\x1b[1C3d4d\x1b[1C0fff DG=7c2652f83d4d0fff";
    expect(boundTerminalOutput([row, "", "kept"])).toBe("kept");
    const joinedCopy = "caFe12\x1b[Cbeef34\x1b[Cdead caFe12beef34dead\x1b[CRouter";
    expect(boundTerminalOutput([joinedCopy, "", "kept"])).toBe("kept");
  });

  it("reads a literal gap marker in the output as a character, not a gap", () => {
    expect(boundTerminalOutput([`password=${CURSOR_GAP}hunter.two`, "", "kept"])).toBe("kept");
  });

  it("is null when nothing readable remains", () => {
    expect(boundTerminalOutput([])).toBeNull();
    expect(boundTerminalOutput(["", "   ", ""])).toBeNull();
  });
});

describe("readTerminalOutputForCorrection", () => {
  it("reads the terminal's snapshot", async () => {
    const snapshot = vi.fn().mockResolvedValue({ lines: ["a", "b"] });
    await expect(readTerminalOutputForCorrection(clientWith(snapshot), "t-1")).resolves.toBe(
      "a\nb"
    );
    expect(snapshot).toHaveBeenCalledWith("t-1");
  });

  it("is null without a client or terminal", async () => {
    await expect(readTerminalOutputForCorrection(undefined, "t-1")).resolves.toBeNull();
    await expect(
      readTerminalOutputForCorrection(clientWith(vi.fn()), undefined)
    ).resolves.toBeNull();
  });

  it("is null when the snapshot is missing or fails", async () => {
    await expect(
      readTerminalOutputForCorrection(clientWith(vi.fn().mockResolvedValue(null)), "t-1")
    ).resolves.toBeNull();
    await expect(
      readTerminalOutputForCorrection(clientWith(vi.fn().mockRejectedValue(new Error("x"))), "t-1")
    ).resolves.toBeNull();
  });

  it("gives up on a read that outlasts the budget", async () => {
    const never = vi.fn(() => new Promise(() => {}));
    await expect(readTerminalOutputForCorrection(clientWith(never), "t-1", 10)).resolves.toBeNull();
  });
});

describe("readTerminalContextForCorrection", () => {
  const REPLY = {
    text: "Should I add a shim?",
    truncated: false,
    recordedAt: 1,
    newerRecordsFollow: false,
  };

  it("reads the screen and the agent's reply of the same terminal within one budget", async () => {
    readAgentReply.mockResolvedValue(REPLY);
    const client = clientWith(vi.fn().mockResolvedValue({ lines: ["screen"] }));
    await expect(readTerminalContextForCorrection(client, "t-1", 300)).resolves.toEqual({
      terminalOutput: "screen",
      agentReply: REPLY,
    });
    expect(readAgentReply).toHaveBeenCalledWith(client, "t-1", 300);
  });

  it("keeps whichever read came back when the other gives nothing", async () => {
    readAgentReply.mockResolvedValue(null);
    const screenOnly = clientWith(vi.fn().mockResolvedValue({ lines: ["screen"] }));
    await expect(readTerminalContextForCorrection(screenOnly, "t-1")).resolves.toEqual({
      terminalOutput: "screen",
      agentReply: null,
    });
    readAgentReply.mockResolvedValue(REPLY);
    const failing = clientWith(vi.fn().mockRejectedValue(new Error("x")));
    await expect(readTerminalContextForCorrection(failing, "t-1")).resolves.toEqual({
      terminalOutput: null,
      agentReply: REPLY,
    });
  });
});
