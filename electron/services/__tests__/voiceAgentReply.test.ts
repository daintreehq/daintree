import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import type { AgentLastMessageResult } from "../../../shared/types/agentLastMessage.js";
import { MAX_CORRECTION_REPLY_CHARS } from "../voiceAgentReplyTypes.js";

const readLastMessage = vi.hoisted(() => vi.fn());
vi.mock("../mcp-server/terminalLastMessage.js", () => ({
  handleTerminalReadLastMessageOwned: readLastMessage,
}));

const { boundAgentReply, readAgentReplyForCorrection } = await import("../voiceAgentReply.js");

const NOW = 1_800_000_000_000;

function ok(
  text: string | null,
  overrides: Partial<{ recordedAt: number | null; truncated: boolean; newer: boolean }> = {}
): AgentLastMessageResult {
  return {
    status: "ok",
    provider: "claude",
    message:
      text === null
        ? null
        : {
            id: "msg-1",
            text,
            truncated: overrides.truncated ?? false,
            recordedAt: "recordedAt" in overrides ? overrides.recordedAt! : NOW - 90_000,
            stopReason: "end_turn",
            nextCursor: null,
          },
    unansweredToolUses: [],
    newerRecordsFollow: overrides.newer ?? false,
    fileUpdatedAt: NOW - 90_000,
  };
}

const clientWith = (info: unknown = null) =>
  ({ getTerminalAsync: vi.fn().mockResolvedValue(info) }) as unknown as PtyClient;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
  readLastMessage.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("boundAgentReply", () => {
  it("keeps a short reply as written", () => {
    expect(boundAgentReply("Should I add a shim?\n\nOr a migration?")).toEqual({
      text: "Should I add a shim?\n\nOr a migration?",
      cut: false,
    });
  });

  it("keeps the newest text, starting at a word", () => {
    const head = "older ".repeat(800);
    const out = boundAgentReply(`${head}\n\nShould I add a shim that reads both keys?`)!;
    expect(out.cut).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(MAX_CORRECTION_REPLY_CHARS);
    expect(out.text.endsWith("Should I add a shim that reads both keys?")).toBe(true);
    expect(out.text.startsWith("older")).toBe(true);
  });

  it("drops the first paragraph of a head the transcript read already cut", () => {
    const out = boundAgentReply(
      "d9f2a7c1e4b8 is the value\nstill the cut one\n\nShall I push?",
      true
    )!;
    expect(out.text).toBe("Shall I push?");
    expect(boundAgentReply("only a cut line\nShall I push?", true)!.text).toBe("Shall I push?");
  });

  it("redacts a credential colour codes split", () => {
    const out = boundAgentReply("\x1b[36mpassword\x1b[39m: hunter2\n\nShall I push?")!;
    expect(out.text).toBe("Shall I push?");
  });

  it("empties a line holding a credential and folds the blank run it leaves", () => {
    const secret = `ghp_${"a1B2".repeat(9)}`;
    const out = boundAgentReply(`I set it up.\n\nexport GITHUB_TOKEN=${secret}\n\nShall I push?`)!;
    expect(out.text).not.toContain(secret);
    expect(out.text).toBe("I set it up.\n\nShall I push?");
  });

  it("gives nothing for a reply with nothing readable left", () => {
    expect(boundAgentReply("  \n\n ")).toBeNull();
    expect(boundAgentReply("password: hunter2")).toBeNull();
  });
});

describe("readAgentReplyForCorrection", () => {
  it("reads the reply with the state observed and when each was stamped", async () => {
    readLastMessage.mockResolvedValue(ok("Should I write a migration, or add a shim?"));
    const client = clientWith({
      agentState: "waiting",
      waitingReason: "question",
      lastStateChange: NOW - 40_000,
    });
    await expect(readAgentReplyForCorrection(client, "term-1", 500)).resolves.toEqual({
      text: "Should I write a migration, or add a shim?",
      truncated: false,
      recordedAt: NOW - 90_000,
      newerRecordsFollow: false,
      observedState: {
        state: "waiting",
        waitingReason: "question",
        lastStateChangeAt: NOW - 40_000,
      },
    });
    expect(readLastMessage).toHaveBeenCalledWith(
      "term-1",
      expect.objectContaining({ maxBytes: expect.any(Number) }),
      expect.any(AbortSignal)
    );
  });

  it("sends the reply alone when no state was observed", async () => {
    readLastMessage.mockResolvedValue(ok("Done.", { recordedAt: null, newer: true }));
    const reply = await readAgentReplyForCorrection(clientWith(null), "term-1", 500);
    expect(reply).toEqual({
      text: "Done.",
      truncated: false,
      recordedAt: null,
      newerRecordsFollow: true,
    });
  });

  it("keeps a state never stamped as unknown", async () => {
    readLastMessage.mockResolvedValue(ok("Done."));
    const reply = await readAgentReplyForCorrection(
      clientWith({ agentState: "idle", lastStateChange: Number.NaN }),
      "term-1",
      500
    );
    expect(reply?.observedState).toEqual({ state: "idle", lastStateChangeAt: null });
  });

  it("sends the reply without a state when the state read fails or runs out", async () => {
    readLastMessage.mockResolvedValue(ok("Done."));
    const failing = {
      getTerminalAsync: vi.fn().mockRejectedValue(new Error("rpc")),
    } as unknown as PtyClient;
    await expect(readAgentReplyForCorrection(failing, "term-1", 500)).resolves.toMatchObject({
      text: "Done.",
    });
    const hanging = {
      getTerminalAsync: vi.fn(() => new Promise(() => {})),
    } as unknown as PtyClient;
    const reply = readAgentReplyForCorrection(hanging, "term-1", 200);
    await vi.advanceTimersByTimeAsync(200);
    const read = await reply;
    expect(read?.text).toBe("Done.");
    expect(read).not.toHaveProperty("observedState");
  });

  it("carries a cut the transcript read made", async () => {
    readLastMessage.mockResolvedValue(ok("cut line\n\ntail of a long reply", { truncated: true }));
    const reply = await readAgentReplyForCorrection(clientWith(), "term-1", 500);
    expect(reply?.truncated).toBe(true);
  });

  it.each([
    ["another agent", { status: "unavailable", reason: "provider-mismatch" }],
    ["a store never pinned down", { status: "unavailable", reason: "store-unknown" }],
    ["no reply on record", { status: "unavailable", reason: "no-message" }],
    ["only an unanswered tool use", ok(null)],
    ["a reply with nothing readable", ok("API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz0123")],
  ])("gives nothing for %s", async (_name, result) => {
    readLastMessage.mockResolvedValue(result);
    await expect(readAgentReplyForCorrection(clientWith(), "term-1", 500)).resolves.toBeNull();
  });

  it("gives nothing without a terminal or a client", async () => {
    await expect(readAgentReplyForCorrection(undefined, "term-1", 500)).resolves.toBeNull();
    await expect(readAgentReplyForCorrection(clientWith(), undefined, 500)).resolves.toBeNull();
    expect(readLastMessage).not.toHaveBeenCalled();
  });

  it("gives nothing when the read fails", async () => {
    readLastMessage.mockRejectedValue(new Error("EACCES"));
    await expect(readAgentReplyForCorrection(clientWith(), "term-1", 500)).resolves.toBeNull();
  });

  it("gives up on a read slower than its budget and cancels it", async () => {
    let signal: AbortSignal | undefined;
    readLastMessage.mockImplementation((_id: string, _options: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    const reply = readAgentReplyForCorrection(clientWith(), "term-1", 200);
    await vi.advanceTimersByTimeAsync(200);
    await expect(reply).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });
});
