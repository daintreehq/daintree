import { describe, expect, it, vi } from "vitest";
import { createTerminalIOHandlers } from "../terminalIO.js";
import type { HostContext } from "../types.js";

describe("submit (#15521)", () => {
  function setup() {
    const ptyManager = { submit: vi.fn() };
    const handler = createTerminalIOHandlers({
      ptyManager,
      sendEvent: vi.fn(),
    } as unknown as HostContext).submit!;
    return { ptyManager, handler };
  }

  it("hands the first-prompt candidate to the terminal with the submission", () => {
    const { ptyManager, handler } = setup();

    handler({
      type: "submit",
      id: "t1",
      text: "Fix the login bug",
      firstPrompt: { text: "Fix the login bug", truncated: true },
    });

    expect(ptyManager.submit).toHaveBeenCalledWith(
      "t1",
      "Fix the login bug",
      undefined,
      undefined,
      undefined,
      undefined,
      { text: "Fix the login bug", truncated: true }
    );
  });

  it("drops a candidate that isn't one", () => {
    const { ptyManager, handler } = setup();

    handler({ type: "submit", id: "t1", text: "go" });
    handler({
      type: "submit",
      id: "t1",
      text: "go",
      firstPrompt: { text: 42, truncated: "yes" } as never,
    });

    for (const call of ptyManager.submit.mock.calls) expect(call[6]).toBeUndefined();
  });
});

describe("submit guards (#16015)", () => {
  function setup() {
    const ptyManager = { submit: vi.fn() };
    const handler = createTerminalIOHandlers({
      ptyManager,
      sendEvent: vi.fn(),
    } as unknown as HostContext).submit!;
    return { ptyManager, handler };
  }

  it("passes an exact guard on with only its run fields, and makes a malformed one refuse", () => {
    const { ptyManager, handler } = setup();
    const send = (guard: unknown) =>
      handler({ type: "submit", id: "t1", text: "answer", guard: guard as never });

    send({ kind: "settled-prompt-exact", agentIncarnation: 2, agentSessionId: "s-1", extra: 1 });
    send({ kind: "settled-prompt-exact" });
    send({ kind: "settled-prompt-exact", agentIncarnation: "2" });
    send({ kind: "settled-prompt-exact", agentIncarnation: 1, agentSessionId: 7 });
    send({ kind: "anything-goes" });
    send("settled-prompt-strict");

    const refusing = { kind: "settled-prompt-exact", agentIncarnation: -1 };
    expect(ptyManager.submit.mock.calls.map((call) => call[4])).toEqual([
      { kind: "settled-prompt-exact", agentIncarnation: 2, agentSessionId: "s-1" },
      { kind: "settled-prompt-exact" },
      refusing,
      refusing,
      refusing,
      "settled-prompt-strict",
    ]);
  });
});
