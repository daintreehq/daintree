import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

describe("xterm cursor-line resize ownership", () => {
  it("leaves an unfinished cursor line for the foreground application to repaint", async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, scrollback: 20 });
    try {
      await write(terminal, "123456789012345678");

      terminal.resize(10, 4);

      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("1234567890");
      expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe("");
      expect(terminal.buffer.active.cursorY).toBe(0);
    } finally {
      terminal.dispose();
    }
  });
});
