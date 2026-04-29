/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useRef } from "react";

// Mock terminalClient and terminalInstanceService
vi.mock("@/clients", () => ({
  terminalClient: {
    write: vi.fn(),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    notifyUserInput: vi.fn(),
  },
}));

import { IMAGE_EXTENSIONS, useTerminalFileTransfer } from "../useTerminalFileTransfer";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { escapeShellArgOptional } from "@shared/utils/shellEscape.js";

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

  function renderFileTransferHook(options?: {
    isInputLocked?: boolean;
    onInput?: (data: string) => void;
  }) {
    return renderHook(() => {
      const ref = useRef<HTMLDivElement>(container);
      useTerminalFileTransfer(ref, {
        terminalId: "term-1",
        isInputLocked: options?.isInputLocked,
        onInput: options?.onInput,
      });
    });
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

  // --- Image paste tests ---

  it("image paste calls saveImage and writes escaped path to terminal", async () => {
    renderFileTransferHook();
    const event = makePasteEvent(true);

    await act(async () => {
      container.dispatchEvent(event);
      // Allow async saveImage to resolve
      await vi.waitFor(() => {
        expect(terminalClient.write).toHaveBeenCalled();
      });
    });

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      escapeShellArgOptional("/tmp/daintree-clipboard/clipboard-123-abc.png")
    );
    expect(terminalInstanceService.notifyUserInput).toHaveBeenCalledWith("term-1");
    expect(event.defaultPrevented).toBe(true);
  });

  it("image paste calls onInput with the escaped path", async () => {
    const onInput = vi.fn();
    renderFileTransferHook({ onInput });
    const event = makePasteEvent(true);

    await act(async () => {
      container.dispatchEvent(event);
      await vi.waitFor(() => {
        expect(onInput).toHaveBeenCalled();
      });
    });

    expect(onInput).toHaveBeenCalledWith(
      escapeShellArgOptional("/tmp/daintree-clipboard/clipboard-123-abc.png")
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
    const event = makePasteEvent(true);

    await act(async () => {
      container.dispatchEvent(event);
      // Wait a tick for the async handler to complete
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(terminalClient.write).not.toHaveBeenCalled();
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
    const event = makePasteEvent(true);

    await act(async () => {
      container.dispatchEvent(event);
      await vi.waitFor(() => {
        expect(terminalClient.write).toHaveBeenCalled();
      });
    });

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      escapeShellArgOptional("/tmp/daintree clipboard/my screenshot.png")
    );
  });

  // --- File drop tests ---

  it("file drop resolves paths and writes them to terminal", () => {
    renderFileTransferHook();

    const file1 = new File([""], "document.pdf");
    Object.defineProperty(file1, "_testPath", { value: "/Users/test/document.pdf" });

    const file2 = new File([""], "script.sh");
    Object.defineProperty(file2, "_testPath", { value: "/Users/test/script.sh" });

    const event = makeDropEvent([file1, file2]);
    container.dispatchEvent(event);

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      `${escapeShellArgOptional("/Users/test/document.pdf")} ${escapeShellArgOptional("/Users/test/script.sh")}`
    );
    expect(terminalInstanceService.notifyUserInput).toHaveBeenCalledWith("term-1");
    expect(event.defaultPrevented).toBe(true);
  });

  it("file drop escapes paths with spaces", () => {
    renderFileTransferHook();

    const file = new File([""], "my file.pdf");
    Object.defineProperty(file, "_testPath", { value: "/Users/test/my file.pdf" });

    const event = makeDropEvent([file]);
    container.dispatchEvent(event);

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      escapeShellArgOptional("/Users/test/my file.pdf")
    );
  });

  it("file drop with unresolved path skips that file", () => {
    renderFileTransferHook();

    const file1 = new File([""], "resolved.pdf");
    Object.defineProperty(file1, "_testPath", { value: "/Users/test/resolved.pdf" });

    const file2 = new File([""], "unresolved.pdf");
    // No _testPath → getPathForFile returns ""

    const event = makeDropEvent([file1, file2]);
    container.dispatchEvent(event);

    expect(terminalClient.write).toHaveBeenCalledWith(
      "term-1",
      escapeShellArgOptional("/Users/test/resolved.pdf")
    );
  });

  it("file drop with all unresolved paths does not write to terminal", () => {
    renderFileTransferHook();

    const file = new File([""], "unresolved.pdf");
    // No _testPath → returns ""

    const event = makeDropEvent([file]);
    container.dispatchEvent(event);

    expect(terminalClient.write).not.toHaveBeenCalled();
  });

  it("file drop is blocked when isInputLocked is true", () => {
    renderFileTransferHook({ isInputLocked: true });

    const file = new File([""], "file.pdf");
    Object.defineProperty(file, "_testPath", { value: "/Users/test/file.pdf" });

    const event = makeDropEvent([file]);
    container.dispatchEvent(event);

    expect(terminalClient.write).not.toHaveBeenCalled();
  });

  it("file drop calls onInput with the joined paths", () => {
    const onInput = vi.fn();
    renderFileTransferHook({ onInput });

    const file = new File([""], "file.ts");
    Object.defineProperty(file, "_testPath", { value: "/Users/test/file.ts" });

    const event = makeDropEvent([file]);
    container.dispatchEvent(event);

    expect(onInput).toHaveBeenCalledWith(escapeShellArgOptional("/Users/test/file.ts"));
  });

  // --- Drag event tests ---

  it("dragover with files sets dropEffect to copy and prevents default", () => {
    renderFileTransferHook();
    const event = makeDragEvent("dragover", true);
    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("dragover without files does not prevent default", () => {
    renderFileTransferHook();
    const event = makeDragEvent("dragover", false);
    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
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
