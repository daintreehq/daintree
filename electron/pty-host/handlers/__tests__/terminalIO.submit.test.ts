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
