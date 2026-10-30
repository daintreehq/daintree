import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findReplySpan, copyWithToast, remoteHost } = vi.hoisted(() => ({
  findReplySpan: vi.fn<(payload: { terminalId: string; selection: string }) => Promise<unknown>>(),
  copyWithToast: vi.fn(),
  remoteHost: { current: null as string | null },
}));

vi.mock("@/clients/claudeClient", () => ({ claudeClient: { findReplySpan } }));
vi.mock("@/lib/copyWithToast", () => ({ copyWithToast }));
vi.mock("@/lib/copyFlash", () => ({ captureCopyFlash: () => "ticket" }));
vi.mock("@/services/terminal/remoteLoopbackLinks", () => ({
  remoteHostOfView: () => remoteHost.current,
}));

import { copyCleanSelection } from "../copyCleanSelection";
import { REPLY_SPAN_WAIT_MS } from "@shared/config/replySpanLimits";

const SELECTION = "⏺ Run the build first, then npm test\n  before you push.";
const CLEANED = "Run the build first, then npm test\nbefore you push.";
const ORIGINAL = "Run the **build** first, then `npm test` before you push.";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("copyCleanSelection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    findReplySpan.mockReset();
    copyWithToast.mockReset();
    remoteHost.current = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("copies a Claude Code reply as it was written when the host finds it", async () => {
    findReplySpan.mockResolvedValue(ORIGINAL);

    copyCleanSelection(SELECTION, CLEANED, "t-1");
    await vi.runAllTimersAsync();

    expect(findReplySpan).toHaveBeenCalledWith({ terminalId: "t-1", selection: SELECTION });
    expect(copyWithToast).toHaveBeenCalledTimes(1);
    expect(copyWithToast).toHaveBeenCalledWith("Selection", ORIGINAL, { flash: "ticket" });
  });

  it.each([
    ["written with LF", "- **one**\n- two"],
    ["already written with CRLF", "- **one**\r\n- two"],
  ])("keeps the selection's line endings for a reply %s", async (_label, span) => {
    findReplySpan.mockResolvedValue(span);

    copyCleanSelection("  - one\r\n  - two", "- one\r\n- two", "t-1");
    await vi.runAllTimersAsync();

    expect(copyWithToast).toHaveBeenCalledWith("Selection", "- **one**\r\n- two", {
      flash: "ticket",
    });
  });

  it.each([
    ["finds nothing", () => Promise.resolve(null)],
    ["fails", () => Promise.reject(new Error("gone"))],
    [
      "isn't there",
      () => {
        throw new TypeError("window.electron.claude is undefined");
      },
    ],
  ])("copies the rebuilt text when the host %s", async (_label, answer) => {
    findReplySpan.mockImplementation(answer);

    copyCleanSelection(SELECTION, CLEANED, "t-1");
    await vi.runAllTimersAsync();

    expect(copyWithToast).toHaveBeenCalledTimes(1);
    expect(copyWithToast).toHaveBeenCalledWith("Selection", CLEANED, { flash: "ticket" });
  });

  it("copies the rebuilt text once the wait runs out, and ignores the answer after", async () => {
    const answer = deferred<string | null>();
    findReplySpan.mockReturnValue(answer.promise);

    copyCleanSelection(SELECTION, CLEANED, "t-1");
    await vi.advanceTimersByTimeAsync(REPLY_SPAN_WAIT_MS - 1);
    expect(copyWithToast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(copyWithToast).toHaveBeenCalledWith("Selection", CLEANED, { flash: "ticket" });

    answer.resolve(ORIGINAL);
    await vi.runAllTimersAsync();
    expect(copyWithToast).toHaveBeenCalledTimes(1);
  });

  it("lets a later clean copy win over one still waiting", async () => {
    const first = deferred<string | null>();
    findReplySpan.mockReturnValueOnce(first.promise);

    copyCleanSelection(SELECTION, CLEANED, "t-1");
    copyCleanSelection("plain", "plain", null);
    first.resolve(ORIGINAL);
    await vi.runAllTimersAsync();

    expect(copyWithToast).toHaveBeenCalledTimes(1);
    expect(copyWithToast).toHaveBeenCalledWith("Selection", "plain");
  });

  it("copies straight away, without asking, for any other pane", () => {
    copyCleanSelection("  codex output  ", "codex output", null);

    expect(findReplySpan).not.toHaveBeenCalled();
    expect(copyWithToast).toHaveBeenCalledWith("Selection", "codex output");
  });

  it("never asks for a view on another machine, or for a selection past the bound", () => {
    remoteHost.current = "host-2";
    copyCleanSelection(SELECTION, CLEANED, "t-1");
    remoteHost.current = null;
    copyCleanSelection("x".repeat(256 * 1024 + 1), "x", "t-1");

    expect(findReplySpan).not.toHaveBeenCalled();
    expect(copyWithToast).toHaveBeenNthCalledWith(1, "Selection", CLEANED);
    expect(copyWithToast).toHaveBeenNthCalledWith(2, "Selection", "x");
  });

  it("copies nothing when there is nothing cleaned to fall back on", async () => {
    copyCleanSelection("   ", "", "t-1");
    await vi.runAllTimersAsync();

    expect(findReplySpan).not.toHaveBeenCalled();
    expect(copyWithToast).not.toHaveBeenCalled();
  });
});
