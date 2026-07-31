/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useRef } from "react";

// Mutable terminal-instance state so each test can pick the delivery branch
// (bracketed paste on/off, managed instance present/absent) without swapping
// mock implementations, which would leak across tests.
const instanceState = vi.hoisted(() => ({
  bracketedPasteMode: false,
  hasManagedInstance: true,
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    write: vi.fn(),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    notifyUserInput: vi.fn(),
    get: vi.fn(() =>
      instanceState.hasManagedInstance
        ? { terminal: { modes: { bracketedPasteMode: instanceState.bracketedPasteMode } } }
        : null
    ),
  },
}));

import { IMAGE_EXTENSIONS, useTerminalFileTransfer } from "../useTerminalFileTransfer";
import { formatAtFileToken } from "../hybridInputParsing";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { escapeShellArgOptional } from "@shared/utils/shellEscape.js";
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  formatWithBracketedPaste,
} from "@shared/utils/terminalInputProtocol.js";

/** The payload handed to `terminalClient.write` for the most recent call. */
function lastWrittenPayload(): string {
  const calls = vi.mocked(terminalClient.write).mock.calls;
  return calls[calls.length - 1]![1] as string;
}

describe("IMAGE_EXTENSIONS", () => {
  it("matches common image formats", () => {
    expect(IMAGE_EXTENSIONS.test("photo.png")).toBe(true);
    expect(IMAGE_EXTENSIONS.test("photo.jpg")).toBe(true);
    expect(IMAGE_EXTENSIONS.test("photo.jpeg")).toBe(true);
    expect(IMAGE_EXTENSIONS.test("photo.bmp")).toBe(true);
    expect(IMAGE_EXTENSIONS.test("photo.tiff")).toBe(true);
    expect(IMAGE_EXTENSIONS.test("photo.tif")).toBe(true);
    expect(IMAGE_EXTENSIONS.test("photo.avif")).toBe(true);
    expect(IMAGE_EXTENSIONS.test("photo.heic")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(IMAGE_EXTENSIONS.test("photo.PNG")).toBe(true);
    expect(IMAGE_EXTENSIONS.test("photo.JPG")).toBe(true);
    expect(IMAGE_EXTENSIONS.test("photo.HEIC")).toBe(true);
  });

  it("does not match non-image formats", () => {
    expect(IMAGE_EXTENSIONS.test("file.pdf")).toBe(false);
    expect(IMAGE_EXTENSIONS.test("file.ts")).toBe(false);
    expect(IMAGE_EXTENSIONS.test("file.txt")).toBe(false);
    expect(IMAGE_EXTENSIONS.test("file.svg")).toBe(false);
    expect(IMAGE_EXTENSIONS.test("file.gif")).toBe(false);
  });
});

describe("useTerminalFileTransfer hook", () => {
  let container: HTMLDivElement;
  let originalElectron: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    instanceState.bracketedPasteMode = false;
    instanceState.hasManagedInstance = true;
    container = document.createElement("div");
    document.body.appendChild(container);

    originalElectron = (window as unknown as Record<string, unknown>).electron;
    (window as unknown as Record<string, unknown>).electron = {
      clipboard: {
        saveImage: vi.fn().mockResolvedValue({
          filePath: "/tmp/daintree-clipboard/clipboard-123-abc.png",
          thumbnailDataUrl: "data:image/png;base64,abc",
        }),
        thumbnailFromPath: vi.fn(),
      },
      webUtils: {
        getPathForFile: vi.fn((file: File) => {
          return (file as unknown as { _testPath?: string })._testPath ?? "";
        }),
      },
    };
  });

  afterEach(() => {
    cleanup();
    if (container.parentNode) document.body.removeChild(container);
    (window as unknown as Record<string, unknown>).electron = originalElectron;
  });

  // Derived from the hook's own options type, so a tightened contract surfaces
  // here as a type error instead of being papered over by a cast.
  type HookProps = Omit<Parameters<typeof useTerminalFileTransfer>[1], "terminalId">;

  function renderFileTransferHook(options: HookProps = {}) {
    return renderHook(
      (props: HookProps) => {
        const ref = useRef<HTMLDivElement>(container);
        return useTerminalFileTransfer(ref, { terminalId: "term-1", ...props });
      },
      { initialProps: options }
    );
  }

  function makePasteEvent(hasImage: boolean): ClipboardEvent {
    const items = hasImage
      ? [{ kind: "file", type: "image/png", getAsFile: () => new File([""], "img.png") }]
      : [{ kind: "string", type: "text/plain", getAsFile: () => null }];

    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: {
        items,
        getData: () => "some text",
        types: hasImage ? ["Files"] : ["text/plain"],
      },
    });
    return event;
  }

  function fileAt(name: string, path?: string): File {
    const file = new File([""], name);
    if (path !== undefined) Object.defineProperty(file, "_testPath", { value: path });
    return file;
  }

  function makeDropEvent(files: File[]): DragEvent {
    const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: {
        files,
        types: ["Files"],
        dropEffect: "none",
      },
    });
    return event;
  }

  function makeDragEvent(type: string, hasFiles: boolean): DragEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: {
        types: hasFiles ? ["Files"] : ["text/plain"],
        dropEffect: "none",
      },
    });
    return event;
  }

  function dropFiles(files: File[]): DragEvent {
    const event = makeDropEvent(files);
    act(() => {
      container.dispatchEvent(event);
    });
    return event;
  }

  async function pasteImage(): Promise<ClipboardEvent> {
    const event = makePasteEvent(true);
    await act(async () => {
      container.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
    return event;
  }

  // --- Image paste tests ---

  it("image paste calls saveImage and writes escaped path to terminal", async () => {
    renderFileTransferHook();
    const event = await pasteImage();

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      `${escapeShellArgOptional("/tmp/daintree-clipboard/clipboard-123-abc.png")} `
    );
    expect(terminalInstanceService.notifyUserInput).toHaveBeenCalledWith("term-1");
    expect(event.defaultPrevented).toBe(true);
  });

  it("image paste calls onInput with the escaped path", async () => {
    const onInput = vi.fn();
    renderFileTransferHook({ onInput });
    await pasteImage();

    expect(onInput).toHaveBeenCalledWith(
      `${escapeShellArgOptional("/tmp/daintree-clipboard/clipboard-123-abc.png")} `
    );
  });

  it("text-only paste does not call saveImage and is not prevented", () => {
    renderFileTransferHook();
    const event = makePasteEvent(false);

    container.dispatchEvent(event);

    expect(window.electron.clipboard.saveImage).not.toHaveBeenCalled();
    expect(terminalClient.write).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("image paste with saveImage failure does not write to terminal", async () => {
    (window.electron.clipboard.saveImage as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("No image in clipboard"), {
        name: "AppError",
        code: "CLIPBOARD_EMPTY",
      })
    );

    renderFileTransferHook();
    const event = await pasteImage();

    expect(event.defaultPrevented).toBe(true);
    expect(terminalClient.write).not.toHaveBeenCalled();
    expect(terminalInstanceService.notifyUserInput).not.toHaveBeenCalled();
  });

  it("image paste is blocked when isInputLocked is true", () => {
    renderFileTransferHook({ isInputLocked: true });
    const event = makePasteEvent(true);

    container.dispatchEvent(event);

    expect(window.electron.clipboard.saveImage).not.toHaveBeenCalled();
    expect(terminalClient.write).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("image paste escapes paths with spaces", async () => {
    (window.electron.clipboard.saveImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      filePath: "/tmp/daintree clipboard/my screenshot.png",
      thumbnailDataUrl: "data:image/png;base64,abc",
    });

    renderFileTransferHook();
    await pasteImage();

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      `${escapeShellArgOptional("/tmp/daintree clipboard/my screenshot.png")} `
    );
  });

  it("image paste into an agent terminal writes an @ token, not a shell path", async () => {
    renderFileTransferHook({ detectedAgentId: "claude" });
    await pasteImage();

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      `${formatAtFileToken("/tmp/daintree-clipboard/clipboard-123-abc.png")} `
    );
  });

  it("locking while the image is still saving suppresses the write", async () => {
    let releaseSave: (value: { filePath: string }) => void = () => {};
    (window.electron.clipboard.saveImage as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<{ filePath: string }>((resolve) => {
        releaseSave = resolve;
      })
    );

    const { rerender } = renderFileTransferHook({ isInputLocked: false });

    act(() => {
      container.dispatchEvent(makePasteEvent(true));
    });

    // Lock lands after the paste started but before saveImage settles.
    rerender({ isInputLocked: true });

    await act(async () => {
      releaseSave({ filePath: "/tmp/late.png" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(terminalClient.write).not.toHaveBeenCalled();
    expect(terminalInstanceService.notifyUserInput).not.toHaveBeenCalled();
  });

  it("re-reads the agent identity across the save, not the one at paste time", async () => {
    let releaseSave: (value: { filePath: string }) => void = () => {};
    (window.electron.clipboard.saveImage as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<{ filePath: string }>((resolve) => {
        releaseSave = resolve;
      })
    );

    // Pasted while a shell owned the terminal…
    const { rerender } = renderFileTransferHook({});

    act(() => {
      container.dispatchEvent(makePasteEvent(true));
    });

    // …but an agent is detected before the image finishes saving.
    rerender({ detectedAgentId: "claude" });

    await act(async () => {
      releaseSave({ filePath: "/tmp/shot.png" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(lastWrittenPayload()).toBe(`${formatAtFileToken("/tmp/shot.png")} `);
  });

  it("unmounting while the image is still saving suppresses the write", async () => {
    let releaseSave: (value: { filePath: string }) => void = () => {};
    (window.electron.clipboard.saveImage as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<{ filePath: string }>((resolve) => {
        releaseSave = resolve;
      })
    );

    const { unmount } = renderFileTransferHook();

    act(() => {
      container.dispatchEvent(makePasteEvent(true));
    });

    unmount();

    await act(async () => {
      releaseSave({ filePath: "/tmp/late.png" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(terminalClient.write).not.toHaveBeenCalled();
    expect(terminalInstanceService.notifyUserInput).not.toHaveBeenCalled();
  });

  // --- File drop tests ---

  it("file drop resolves paths and writes them to terminal", () => {
    renderFileTransferHook();

    const event = dropFiles([
      fileAt("document.pdf", "/Users/test/document.pdf"),
      fileAt("script.sh", "/Users/test/script.sh"),
    ]);

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      `${escapeShellArgOptional("/Users/test/document.pdf")} ${escapeShellArgOptional("/Users/test/script.sh")} `
    );
    expect(terminalInstanceService.notifyUserInput).toHaveBeenCalledWith("term-1");
    expect(event.defaultPrevented).toBe(true);
  });

  it("file drop escapes paths with spaces", () => {
    renderFileTransferHook();
    dropFiles([fileAt("my file.pdf", "/Users/test/my file.pdf")]);

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      `${escapeShellArgOptional("/Users/test/my file.pdf")} `
    );
  });

  it("file drop with unresolved path skips that file", () => {
    renderFileTransferHook();
    dropFiles([fileAt("resolved.pdf", "/Users/test/resolved.pdf"), fileAt("unresolved.pdf")]);

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      `${escapeShellArgOptional("/Users/test/resolved.pdf")} `
    );
  });

  it("file drop with all unresolved paths does not write to terminal", () => {
    renderFileTransferHook();
    dropFiles([fileAt("unresolved.pdf")]);

    expect(terminalClient.write).not.toHaveBeenCalled();
  });

  it("file drop is blocked when isInputLocked is true", () => {
    renderFileTransferHook({ isInputLocked: true });
    dropFiles([fileAt("file.pdf", "/Users/test/file.pdf")]);

    expect(terminalClient.write).not.toHaveBeenCalled();
  });

  it("file drop calls onInput with the joined paths", () => {
    const onInput = vi.fn();
    renderFileTransferHook({ onInput });
    dropFiles([fileAt("file.ts", "/Users/test/file.ts")]);

    expect(onInput).toHaveBeenCalledWith(`${escapeShellArgOptional("/Users/test/file.ts")} `);
  });

  // --- Runtime identity decides the content format (#11574) ---

  const AGENT_IDENTITIES: Array<[string, HookProps]> = [
    ["a detected agent", { detectedAgentId: "claude" }],
    ["a launched agent with no detection yet", { launchAgentId: "claude" }],
    [
      "a detected agent even while an exit signal is present",
      { detectedAgentId: "claude", launchAgentId: "claude", agentState: "exited" },
    ],
  ];

  it.each(AGENT_IDENTITIES)("formats dropped paths as @ tokens for %s", (_label, identity) => {
    renderFileTransferHook(identity);
    dropFiles([fileAt("App.tsx", "/Users/test/src/App.tsx")]);

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      `${formatAtFileToken("/Users/test/src/App.tsx")} `
    );
  });

  const SHELL_IDENTITIES: Array<[string, HookProps]> = [
    ["a plain shell", {}],
    ["a launched agent that has since exited", { launchAgentId: "claude", agentState: "exited" }],
  ];

  it.each(SHELL_IDENTITIES)("shell-escapes dropped paths for %s", (_label, identity) => {
    renderFileTransferHook(identity);
    dropFiles([fileAt("App.tsx", "/Users/test/src/App.tsx")]);

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      `${escapeShellArgOptional("/Users/test/src/App.tsx")} `
    );
  });

  it("quotes @ tokens for paths containing whitespace", () => {
    renderFileTransferHook({ detectedAgentId: "claude" });
    dropFiles([fileAt("my notes.md", "/Users/test/my notes.md")]);

    // Pinned to the literal wire format an agent CLI has to parse, rather than
    // re-deriving it from the same formatter the hook calls — an unquoted space
    // would split the reference into two arguments.
    expect(lastWrittenPayload()).toBe('@"/Users/test/my notes.md" ');
  });

  it("writes the plain @ wire format for a path needing no quoting", () => {
    renderFileTransferHook({ detectedAgentId: "claude" });
    dropFiles([fileAt("App.tsx", "/Users/test/src/App.tsx")]);

    expect(lastWrittenPayload()).toBe("@/Users/test/src/App.tsx ");
  });

  it("switches format when the detected agent changes, without re-registering listeners", () => {
    const addSpy = vi.spyOn(container, "addEventListener");
    const { rerender } = renderFileTransferHook({});
    const registrationsAfterMount = addSpy.mock.calls.length;

    dropFiles([fileAt("a.ts", "/Users/test/a.ts")]);
    expect(lastWrittenPayload()).toBe(`${escapeShellArgOptional("/Users/test/a.ts")} `);

    rerender({ detectedAgentId: "claude" });

    dropFiles([fileAt("a.ts", "/Users/test/a.ts")]);
    expect(lastWrittenPayload()).toBe(`${formatAtFileToken("/Users/test/a.ts")} `);

    expect(addSpy.mock.calls.length).toBe(registrationsAfterMount);
    addSpy.mockRestore();
  });

  // --- Bracketed paste decides the delivery (#11574) ---

  it("wraps the whole batch once when the program has bracketed paste on", () => {
    instanceState.bracketedPasteMode = true;
    renderFileTransferHook({ detectedAgentId: "claude" });

    dropFiles([
      fileAt("a.ts", "/Users/test/a.ts"),
      fileAt("b.ts", "/Users/test/b.ts"),
      fileAt("c.ts", "/Users/test/c.ts"),
    ]);

    const payload = lastWrittenPayload();
    const logical = `${formatAtFileToken("/Users/test/a.ts")} ${formatAtFileToken("/Users/test/b.ts")} ${formatAtFileToken("/Users/test/c.ts")} `;

    expect(payload).toBe(formatWithBracketedPaste(logical));
    // One wrapper for the batch, not one per token.
    expect(payload.split(BRACKETED_PASTE_START).length - 1).toBe(1);
    expect(payload.split(BRACKETED_PASTE_END).length - 1).toBe(1);
  });

  it("does not wrap when the program has bracketed paste off", () => {
    instanceState.bracketedPasteMode = false;
    renderFileTransferHook({ detectedAgentId: "claude" });
    dropFiles([fileAt("a.ts", "/Users/test/a.ts")]);

    const payload = lastWrittenPayload();
    expect(payload).toBe(`${formatAtFileToken("/Users/test/a.ts")} `);
    expect(payload).not.toContain(BRACKETED_PASTE_START);
  });

  // The renderer instance is created asynchronously, so a live PTY can exist
  // while `get()` still returns null. "Unknown" must not be read as "on".
  it("falls back to wrapping for an agent when no managed instance exists", () => {
    instanceState.hasManagedInstance = false;
    renderFileTransferHook({ detectedAgentId: "claude" });
    dropFiles([fileAt("a.ts", "/Users/test/a.ts")]);

    expect(lastWrittenPayload()).toBe(
      formatWithBracketedPaste(`${formatAtFileToken("/Users/test/a.ts")} `)
    );
  });

  it("falls back to raw text for a shell when no managed instance exists", () => {
    instanceState.hasManagedInstance = false;
    renderFileTransferHook();
    dropFiles([fileAt("a.ts", "/Users/test/a.ts")]);

    const payload = lastWrittenPayload();
    expect(payload).toBe(`${escapeShellArgOptional("/Users/test/a.ts")} `);
    // A shell that never enabled DECSET 2004 would echo these as literal input.
    expect(payload).not.toContain(BRACKETED_PASTE_START);
  });

  it.each([
    ["carriage return", "\r"],
    ["newline", "\n"],
    ["escape", String.fromCharCode(27)],
  ])("skips a path containing a %s rather than risk submitting it", (_label, char) => {
    // Bracketed paste off is the dangerous case: the program reads CR as Enter.
    instanceState.bracketedPasteMode = false;
    renderFileTransferHook({ detectedAgentId: "claude" });

    dropFiles([fileAt("bad", `/tmp/we${char}ird.ts`), fileAt("good", "/tmp/fine.ts")]);

    // The safe sibling still lands; the unsafe path is dropped like an
    // unresolved one, and nothing that could submit reaches the PTY.
    expect(lastWrittenPayload()).toBe(`${formatAtFileToken("/tmp/fine.ts")} `);
  });

  it("writes nothing when every dropped path carries a control character", () => {
    renderFileTransferHook({ detectedAgentId: "claude" });
    dropFiles([fileAt("bad", "/tmp/we\rird.ts")]);

    expect(terminalClient.write).not.toHaveBeenCalled();
  });

  it("hands onInput the logical text, never the bracket markers", () => {
    instanceState.bracketedPasteMode = true;
    const onInput = vi.fn();
    renderFileTransferHook({ onInput, detectedAgentId: "claude" });

    dropFiles([fileAt("a.ts", "/Users/test/a.ts")]);

    const forwarded = onInput.mock.calls[0]![0] as string;
    expect(forwarded).toBe(`${formatAtFileToken("/Users/test/a.ts")} `);
    expect(forwarded).not.toContain(BRACKETED_PASTE_START);
    expect(forwarded).not.toContain(BRACKETED_PASTE_END);
  });

  it("never submits the insertion", () => {
    instanceState.bracketedPasteMode = true;
    renderFileTransferHook({ detectedAgentId: "claude" });
    dropFiles([fileAt("a.ts", "/Users/test/a.ts")]);

    const payload = lastWrittenPayload();
    expect(payload).not.toContain("\r");
    expect(payload).not.toContain("\n");
  });

  it("writes a mixed image/non-image drop as one ordered batch", () => {
    renderFileTransferHook({ detectedAgentId: "claude" });

    dropFiles([
      fileAt("notes.md", "/Users/test/notes.md"),
      fileAt("shot.png", "/Users/test/shot.png"),
      fileAt("missing.txt"),
      fileAt("my file.ts", "/Users/test/my file.ts"),
    ]);

    // Images take the same @ token as any other path — the terminal has no
    // thumbnail-chip surface to justify the hybrid input's image branch.
    expect(lastWrittenPayload()).toBe(
      `${formatAtFileToken("/Users/test/notes.md")} ${formatAtFileToken("/Users/test/shot.png")} ${formatAtFileToken("/Users/test/my file.ts")} `
    );
    expect(terminalClient.write).toHaveBeenCalledTimes(1);
    expect(terminalInstanceService.notifyUserInput).toHaveBeenCalledTimes(1);
  });

  // --- Drag event tests ---

  it("dragover with files sets dropEffect to copy and prevents default", () => {
    renderFileTransferHook();
    const event = makeDragEvent("dragover", true);
    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(event.dataTransfer!.dropEffect).toBe("copy");
  });

  it("dragover without files does not prevent default", () => {
    renderFileTransferHook();
    const event = makeDragEvent("dragover", false);
    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("dragover while locked does not advertise a copy target", () => {
    renderFileTransferHook({ isInputLocked: true });
    const event = makeDragEvent("dragover", true);
    container.dispatchEvent(event);

    expect(event.dataTransfer!.dropEffect).toBe("none");
  });

  // --- Drag-over state (#11574) ---

  function dispatchDrag(type: string, hasFiles = true) {
    act(() => {
      container.dispatchEvent(makeDragEvent(type, hasFiles));
    });
  }

  it("reports no drag-over state initially", () => {
    const { result } = renderFileTransferHook();
    expect(result.current).toBe(false);
  });

  it("reports drag-over state while files are over the terminal", () => {
    const { result } = renderFileTransferHook();

    dispatchDrag("dragenter");
    expect(result.current).toBe(true);

    dispatchDrag("dragleave");
    expect(result.current).toBe(false);
  });

  it("survives nested dragenter/dragleave over child elements", () => {
    const { result } = renderFileTransferHook();

    dispatchDrag("dragenter");
    dispatchDrag("dragenter");
    expect(result.current).toBe(true);

    // Leaving the inner element must not clear the state — the pointer is
    // still inside the terminal.
    dispatchDrag("dragleave");
    expect(result.current).toBe(true);

    dispatchDrag("dragleave");
    expect(result.current).toBe(false);
  });

  it("clears drag-over state on drop even when nothing resolved", () => {
    const { result } = renderFileTransferHook();

    dispatchDrag("dragenter");
    expect(result.current).toBe(true);

    dropFiles([fileAt("unresolved.pdf")]);

    expect(result.current).toBe(false);
    expect(terminalClient.write).not.toHaveBeenCalled();
  });

  it("ignores drags that carry no files", () => {
    const { result } = renderFileTransferHook();

    dispatchDrag("dragenter", false);

    expect(result.current).toBe(false);
  });

  it("does not advertise a drop target while input is locked", () => {
    const { result } = renderFileTransferHook({ isInputLocked: true });

    dispatchDrag("dragenter");

    expect(result.current).toBe(false);
  });

  it("clears an active drag-over state when input becomes locked", () => {
    const { result, rerender } = renderFileTransferHook({ isInputLocked: false });

    dispatchDrag("dragenter");
    expect(result.current).toBe(true);

    act(() => {
      rerender({ isInputLocked: true });
    });

    expect(result.current).toBe(false);
  });

  it("restores the affordance when input unlocks mid-drag", () => {
    const { result, rerender } = renderFileTransferHook({ isInputLocked: true });

    // The pointer entered while locked, so no further dragenter will arrive.
    // Depth is tracked physically, so unlocking alone must restore feedback —
    // otherwise the drop is silently accepted with nothing on screen.
    dispatchDrag("dragenter");
    expect(result.current).toBe(false);

    act(() => {
      rerender({ isInputLocked: false });
    });

    expect(result.current).toBe(true);
  });

  // --- Cleanup test ---

  it("removes event listeners on unmount", () => {
    const { unmount } = renderFileTransferHook();
    unmount();

    // After unmount, events should not trigger any behavior
    const event = makePasteEvent(true);
    container.dispatchEvent(event);

    expect(window.electron.clipboard.saveImage).not.toHaveBeenCalled();
    expect(terminalClient.write).not.toHaveBeenCalled();
  });
});
