// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLinuxPrimarySelectionListeners } from "../primarySelection";

type ReadSelectionResult = { ok: true; text: string } | { ok: false; error: string };

describe("installLinuxPrimarySelectionListeners", () => {
  let hostElement: HTMLElement;
  let writeToPty: ReturnType<typeof vi.fn<(id: string, data: string) => void>>;
  let notifyUserInput: ReturnType<typeof vi.fn<(id: string) => void>>;
  let writeSelection: ReturnType<typeof vi.fn<(text: string) => Promise<unknown>>>;
  let readSelection: ReturnType<typeof vi.fn<() => Promise<ReadSelectionResult>>>;
  let cachedSelection: string | undefined;
  let bracketedPasteMode: boolean;
  let disposed: boolean;
  let inputLocked: boolean;
  let cleanup: () => void;

  beforeEach(() => {
    hostElement = document.createElement("div");
    document.body.appendChild(hostElement);
    writeToPty = vi.fn<(id: string, data: string) => void>();
    notifyUserInput = vi.fn<(id: string) => void>();
    writeSelection = vi.fn<(text: string) => Promise<unknown>>().mockResolvedValue({ ok: true });
    readSelection = vi
      .fn<() => Promise<ReadSelectionResult>>()
      .mockResolvedValue({ ok: true, text: "" });
    cachedSelection = undefined;
    bracketedPasteMode = false;
    disposed = false;
    inputLocked = false;

    cleanup = installLinuxPrimarySelectionListeners({
      hostElement,
      terminalId: "term-1",
      getCachedSelection: () => cachedSelection,
      getBracketedPasteMode: () => bracketedPasteMode,
      isDisposed: () => disposed,
      isInputLocked: () => inputLocked,
      writeToPty,
      notifyUserInput,
      writeSelection,
      readSelection,
    });
  });

  afterEach(() => {
    cleanup();
    hostElement.remove();
  });

  describe("mouseup (copy-on-select)", () => {
    it("writes the cached selection to PRIMARY on mouseup", () => {
      cachedSelection = "hello world";
      hostElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(writeSelection).toHaveBeenCalledWith("hello world");
    });

    it("does not write when the cached selection is empty", () => {
      cachedSelection = "";
      hostElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(writeSelection).not.toHaveBeenCalled();
    });

    it("does not write when the cached selection is undefined", () => {
      cachedSelection = undefined;
      hostElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(writeSelection).not.toHaveBeenCalled();
    });

    it("silently swallows rejected writeSelection promises", async () => {
      cachedSelection = "hello";
      writeSelection.mockRejectedValueOnce(new Error("compositor lacks primary"));
      hostElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      // No assertion on side effects — the test passes if no unhandled rejection throws.
    });
  });

  describe("auxclick (middle-click paste)", () => {
    it("ignores auxclick when button is not the middle button", async () => {
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 2, bubbles: true }));
      await flush();
      expect(readSelection).not.toHaveBeenCalled();
      expect(writeToPty).not.toHaveBeenCalled();
    });

    it("reads PRIMARY and writes to the PTY on middle-click", async () => {
      readSelection.mockResolvedValueOnce({ ok: true, text: "pasted" });
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      await flush();
      expect(readSelection).toHaveBeenCalledTimes(1);
      expect(writeToPty).toHaveBeenCalledWith("term-1", "pasted");
      expect(notifyUserInput).toHaveBeenCalledWith("term-1");
    });

    it("wraps the payload with bracketed-paste markers when the mode is active", async () => {
      bracketedPasteMode = true;
      readSelection.mockResolvedValueOnce({ ok: true, text: "pasted" });
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      await flush();
      expect(writeToPty).toHaveBeenCalledTimes(1);
      const [id, payload] = writeToPty.mock.calls[0]!;
      expect(id).toBe("term-1");
      expect(payload).toContain("pasted");
      expect(payload).toMatch(/\x1b\[200~/);
      expect(payload).toMatch(/\x1b\[201~/);
    });

    it("normalizes newlines to carriage returns when bracketed paste is off", async () => {
      readSelection.mockResolvedValueOnce({ ok: true, text: "line1\nline2\r\nline3" });
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      await flush();
      expect(writeToPty).toHaveBeenCalledWith("term-1", "line1\rline2\rline3");
    });

    it("skips PTY write when PRIMARY is empty", async () => {
      readSelection.mockResolvedValueOnce({ ok: true, text: "" });
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      await flush();
      expect(writeToPty).not.toHaveBeenCalled();
      expect(notifyUserInput).not.toHaveBeenCalled();
    });

    it("skips PTY write when readSelection returns an error", async () => {
      readSelection.mockResolvedValueOnce({ ok: false, error: "no focus" });
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      await flush();
      expect(writeToPty).not.toHaveBeenCalled();
      expect(notifyUserInput).not.toHaveBeenCalled();
    });

    it("skips PTY write when the terminal was disposed during the async read", async () => {
      readSelection.mockImplementationOnce(async () => {
        disposed = true;
        return { ok: true, text: "pasted" };
      });
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      await flush();
      expect(writeToPty).not.toHaveBeenCalled();
      expect(notifyUserInput).not.toHaveBeenCalled();
    });

    it("skips PTY write when input is locked before the read resolves", async () => {
      inputLocked = true;
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      await flush();
      expect(readSelection).not.toHaveBeenCalled();
      expect(writeToPty).not.toHaveBeenCalled();
    });

    it("skips PTY write when input becomes locked during the async read", async () => {
      readSelection.mockImplementationOnce(async () => {
        inputLocked = true;
        return { ok: true, text: "pasted" };
      });
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      await flush();
      expect(writeToPty).not.toHaveBeenCalled();
    });

    it("silently swallows rejected readSelection promises", async () => {
      readSelection.mockRejectedValueOnce(new Error("ipc unavailable"));
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      await flush();
      expect(writeToPty).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("removes both listeners so later events are ignored", () => {
      cleanup();
      cachedSelection = "after cleanup";
      hostElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      hostElement.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
      expect(writeSelection).not.toHaveBeenCalled();
      expect(readSelection).not.toHaveBeenCalled();
    });
  });
});

async function flush(): Promise<void> {
  // Drain pending microtasks so async auxclick handlers can settle.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}
