import { describe, expect, it } from "vitest";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
import { readCursorLine } from "../analysis/headlessViewport.js";

const { Terminal: HeadlessTerminal } = headless;

function createTerminal(cols: number): HeadlessTerminalType {
  return new HeadlessTerminal({ cols, rows: 10, scrollback: 50, allowProposedApi: true });
}

function write(term: HeadlessTerminalType, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

const PROMPT =
  "PS C:\\Users\\greg\\AppData\\Local\\Temp\\daintree-e2e-terminal-agent-promotion-4C4C6u> ";

describe("readCursorLine", () => {
  it("returns a prompt that wrapped across rows in full", async () => {
    const term = createTerminal(40);
    await write(term, `FAKE_CLAUDE_EXIT\r\n${PROMPT}`);
    expect(readCursorLine(term)).toBe(PROMPT);
  });

  it("reads a long prompt in a narrow split in full", async () => {
    const term = createTerminal(20);
    const prompt = `PS C:\\${"deep\\".repeat(40)}repo> `;
    await write(term, `output\r\n${prompt}`);
    expect(readCursorLine(term)).toBe(prompt);
  });

  it("does not join a row that starts a new line", async () => {
    const term = createTerminal(40);
    await write(term, "first line of output\r\nPS C:\\repo> ");
    expect(readCursorLine(term)).toBe("PS C:\\repo> ");
  });

  it("stops after a bounded number of wrapped rows", async () => {
    const term = createTerminal(10);
    await write(term, "x".repeat(200));
    const line = readCursorLine(term) ?? "";
    expect(line.length).toBeLessThanOrEqual(10 * 33);
    expect(line.length).toBeGreaterThan(10);
  });
});
