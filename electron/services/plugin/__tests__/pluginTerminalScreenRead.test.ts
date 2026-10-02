import { describe, expect, it, vi } from "vitest";

vi.mock("../../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));

import { serializeTerminalTail } from "../../pty/terminalSerialization.js";
import type { TerminalInfo } from "../../pty/types.js";
import {
  activeScreenData,
  admitPluginTerminalScreenRead,
  clipToUtf8Bytes,
  readPluginTerminalScreen,
} from "../pluginTerminalScreenRead.js";

type Record = {
  id: string;
  spawnedAt?: number;
  projectId?: string;
  kind?: string;
  isExited?: boolean;
  isAssistantTerminal?: boolean;
};

function makeClient(record: Record | null, data: string | null = "hello\r\nworld") {
  return {
    getTerminalProjectId: vi.fn((_id: string) => record?.projectId ?? null),
    getTerminalAsync: vi.fn(async (_id: string) => record),
    getSerializedStateAsync: vi.fn(async (_id: string, _options?: { tailRows: number }) =>
      data === null ? null : { data, cols: 80, rows: 24 }
    ),
  };
}

function read(client: ReturnType<typeof makeClient> | null, scope: string | null, lines = 20) {
  return readPluginTerminalScreen(client as never, "t-1", scope, lines);
}

describe("readPluginTerminalScreen", () => {
  it("returns the screen as plain text from a screen-only read", async () => {
    const client = makeClient(
      { id: "t-1", projectId: "p-a", kind: "terminal" },
      "\x1b[32mok\x1b[0m\r\nready"
    );

    await expect(read(client, "p-a")).resolves.toEqual({
      status: "ok",
      text: "ok\nready",
      lineCount: 2,
      truncated: false,
    });
    expect(client.getSerializedStateAsync).toHaveBeenCalledTimes(1);
    expect(client.getSerializedStateAsync).toHaveBeenCalledWith("t-1", { tailRows: 0 });
  });

  it("answers a blank screen as an empty ok, not a missing terminal", async () => {
    const client = makeClient({ id: "t-1", projectId: "p-a" }, "\r\n\r\n   ");
    await expect(read(client, "p-a")).resolves.toEqual({
      status: "ok",
      text: "",
      lineCount: 0,
      truncated: false,
    });
  });

  it("never falls back to a whole-buffer read when the screen is sparse", async () => {
    const client = makeClient({ id: "t-1", projectId: "p-a" }, "one line");
    client.getSerializedStateAsync.mockResolvedValue({
      data: "one line",
      cols: 80,
      rows: 24,
      partial: true,
    } as never);
    await read(client, "p-a", 50);
    expect(client.getSerializedStateAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps the last lines and reports the cut", async () => {
    const client = makeClient({ id: "t-1", projectId: "p-a" }, "a\r\nb\r\nc\r\nd");
    await expect(read(client, "p-a", 2)).resolves.toEqual({
      status: "ok",
      text: "c\nd",
      lineCount: 2,
      truncated: true,
    });
  });

  it("answers a foreign tracked id without reading anything", async () => {
    const client = makeClient({ id: "t-1", projectId: "p-b" });
    await expect(read(client, "p-a")).resolves.toEqual({ status: "not-found" });
    expect(client.getTerminalAsync).not.toHaveBeenCalled();
    expect(client.getSerializedStateAsync).not.toHaveBeenCalled();
  });

  it("gives unknown, foreign, assistant and non-PTY ids the same answer", async () => {
    const cases: Array<Record | null> = [
      null,
      { id: "t-1", projectId: "p-b" },
      { id: "t-1", projectId: "p-a", isAssistantTerminal: true },
      { id: "t-1", projectId: "p-a", kind: "browser" },
    ];
    for (const record of cases) {
      const client = makeClient(record);
      // Untracked locally, so ownership is settled by the pty-host record.
      client.getTerminalProjectId.mockReturnValue(null);
      await expect(read(client, "p-a")).resolves.toEqual({ status: "not-found" });
      expect(client.getSerializedStateAsync).not.toHaveBeenCalled();
    }
  });

  it("lets an unbound host read any user terminal by id", async () => {
    const client = makeClient({ id: "t-1", projectId: "p-b" }, "text");
    await expect(read(client, null)).resolves.toMatchObject({ status: "ok", text: "text" });
  });

  it("reports an exited terminal as exited without reading its preserved buffer", async () => {
    const client = makeClient({ id: "t-1", projectId: "p-a", isExited: true });
    await expect(read(client, "p-a")).resolves.toEqual({ status: "exited" });
    expect(client.getSerializedStateAsync).not.toHaveBeenCalled();
  });

  it("is unavailable when the host is down or the read fails", async () => {
    await expect(read(null, "p-a")).resolves.toEqual({ status: "unavailable" });
    const client = makeClient({ id: "t-1", projectId: "p-a" }, null);
    await expect(read(client, "p-a")).resolves.toEqual({ status: "unavailable" });
  });

  it("answers unavailable, not not-found, when the host fails to answer for a tracked terminal", async () => {
    const client = makeClient(null);
    client.getTerminalProjectId.mockReturnValue("p-a");
    await expect(read(client, "p-a")).resolves.toEqual({ status: "unavailable" });
    expect(client.getSerializedStateAsync).not.toHaveBeenCalled();
  });

  it("discards a screen read across a respawn of the id", async () => {
    const client = makeClient({ id: "t-1", projectId: "p-a", spawnedAt: 1 }, "old");
    client.getTerminalAsync
      .mockResolvedValueOnce({ id: "t-1", projectId: "p-a", spawnedAt: 1 })
      .mockResolvedValueOnce({ id: "t-1", projectId: "p-a", spawnedAt: 2 });
    await expect(read(client, "p-a")).resolves.toEqual({ status: "not-found" });
  });

  it("discards a screen read when the id moved to another project mid-read", async () => {
    const client = makeClient({ id: "t-1", projectId: "p-a", spawnedAt: 1 }, "secret");
    client.getTerminalAsync
      .mockResolvedValueOnce({ id: "t-1", projectId: "p-a", spawnedAt: 1 })
      .mockResolvedValueOnce({ id: "t-1", projectId: "p-b", spawnedAt: 1 });
    await expect(read(client, "p-a")).resolves.toEqual({ status: "not-found" });
  });

  it("answers exited, not the preserved whole buffer, when the terminal exits mid-read", async () => {
    const history = Array.from({ length: 40 }, (_, i) => `history ${i}`).join("\r\n");
    const client = makeClient({ id: "t-1", projectId: "p-a", spawnedAt: 1 }, history);
    client.getTerminalAsync
      .mockResolvedValueOnce({ id: "t-1", projectId: "p-a", spawnedAt: 1 })
      .mockResolvedValueOnce({ id: "t-1", projectId: "p-a", spawnedAt: 1, isExited: true });
    await expect(read(client, "p-a")).resolves.toEqual({ status: "exited" });
  });

  it("caps the text at 16 KiB, keeping the newest lines", async () => {
    const big = Array.from({ length: 100 }, (_, i) => `${i}:${"x".repeat(400)}`).join("\r\n");
    const client = makeClient({ id: "t-1", projectId: "p-a" }, big);
    const result = await read(client, "p-a", 100);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(result.text.endsWith(`99:${"x".repeat(400)}`)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.lineCount).toBe(result.text.split("\n").length);
  });
});

describe("clipToUtf8Bytes", () => {
  it("leaves text under the cap alone", () => {
    expect(clipToUtf8Bytes("a\nb", 10)).toEqual({ text: "a\nb", clipped: false });
  });

  it("drops whole lines from the top", () => {
    expect(clipToUtf8Bytes("aaaa\nbb\ncc", 5)).toEqual({ text: "bb\ncc", clipped: true });
  });

  it("keeps the end of a single oversized line without splitting a character", () => {
    const result = clipToUtf8Bytes("😀😀😀", 9);
    expect(result).toEqual({ text: "😀😀", clipped: true });
  });
});

describe("admitPluginTerminalScreenRead", () => {
  it("admits twenty cards polling once a second, indefinitely", () => {
    const instance = {};
    for (let second = 0; second < 5; second++) {
      for (let card = 0; card < 20; card++) {
        expect(admitPluginTerminalScreenRead(instance, second * 1000 + card)).toBe(true);
      }
    }
  });

  it("rejects past the limit within a rolling second, then admits again", () => {
    const instance = {};
    for (let i = 0; i < 3; i++) expect(admitPluginTerminalScreenRead(instance, 100, 3)).toBe(true);
    expect(admitPluginTerminalScreenRead(instance, 500, 3)).toBe(false);
    expect(admitPluginTerminalScreenRead(instance, 1100, 3)).toBe(true);
  });

  it("keeps a separate window per plugin instance", () => {
    const a = {};
    const b = {};
    expect(admitPluginTerminalScreenRead(a, 0, 1)).toBe(true);
    expect(admitPluginTerminalScreenRead(a, 1, 1)).toBe(false);
    expect(admitPluginTerminalScreenRead(b, 1, 1)).toBe(true);
  });
});

describe("screen text from a real headless terminal", () => {
  async function screenRead(rows: number, output: string, lines = 20) {
    const { Terminal } = await import("@xterm/headless");
    const serializeModule = await import("@xterm/addon-serialize");
    const terminal = new Terminal({ cols: 40, rows, scrollback: 1000, allowProposedApi: true });
    const addon = new serializeModule.default.SerializeAddon();
    terminal.loadAddon(addon);
    await new Promise<void>((resolve) => terminal.write(output, resolve));
    const info = {
      headlessTerminal: terminal,
      serializeAddon: addon,
      preservedSnapshot: undefined,
    } as unknown as TerminalInfo;
    const client = makeClient({ id: "t-1", projectId: "p-a" });
    client.getSerializedStateAsync.mockImplementation(async (_id, options) =>
      serializeTerminalTail("t-1", info, options?.tailRows ?? 0)
    );
    return readPluginTerminalScreen(client as never, "t-1", "p-a", lines);
  }

  it("reads the alternate screen while a TUI holds it, not the shell history beneath", async () => {
    const result = await screenRead(
      5,
      "shell history\r\n\x1b[?1049h\x1b[H\x1b[31mtui frame\x1b[0m\r\nsecond row"
    );
    expect(result).toEqual({
      status: "ok",
      text: "tui frame\nsecond row",
      lineCount: 2,
      truncated: false,
    });
  });

  it("reads the normal screen once the TUI leaves the alternate screen", async () => {
    const result = await screenRead(5, "before\r\n\x1b[?1049hframe\x1b[?1049lafter");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.text).toContain("before");
    expect(result.text).not.toContain("frame");
  });

  it("leaves scrollback out of a long shell session", async () => {
    const output = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\r\n");
    const result = await screenRead(5, output);
    expect(result).toMatchObject({ status: "ok", lineCount: 5 });
    if (result.status !== "ok") return;
    expect(result.text.split("\n")[0]).toBe("line 45");
  });
});

describe("activeScreenData", () => {
  it("passes a normal-screen snapshot through", () => {
    expect(activeScreenData("plain")).toBe("plain");
  });
});
