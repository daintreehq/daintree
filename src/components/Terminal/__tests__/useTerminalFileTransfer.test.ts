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
    // Typed so call payloads read back as string without a cast — the lint
    // ratchet counts `no-unsafe-type-assertion` per rule.
    write: vi.fn<(terminalId: string, data: string) => void>(),
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

import type { EditorView } from "@codemirror/view";
import { IMAGE_EXTENSIONS, useTerminalFileTransfer } from "../useTerminalFileTransfer";
import { useDragDrop } from "../hooks/useDragDrop";
import { formatAtFileToken } from "../hybridInputParsing";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { escapeShellArgOptional } from "@shared/utils/shellEscape.js";
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  formatWithBracketedPaste,
} from "@shared/utils/terminalInputProtocol.js";
import { FILE_DRAG_MIME, encodeFileDragPaths } from "@/lib/fileDragPayload";

/** What `clipboard.saveImage` resolves to, taken from the IPC surface itself. */
type SavedImage = Awaited<ReturnType<typeof window.electron.clipboard.saveImage>>;

/** The payload handed to `terminalClient.write` for the most recent call. */
function lastWrittenPayload(): string {
  const calls = vi.mocked(terminalClient.write).mock.calls;
  return calls[calls.length - 1]![1];
}

/** A worktree root the fixture paths below sit inside. */
const CWD = "/Users/test/proj";

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

  /**
   * A hover from an in-app file drag. Returns the transfer alongside the event
   * so `dropEffect` reads back without narrowing the event to a `DragEvent`.
   */
  function makeInternalDragEvent(type: string): {
    event: Event;
    dataTransfer: { dropEffect: string };
  } {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const dataTransfer = {
      types: [FILE_DRAG_MIME],
      dropEffect: "none",
      // Present so a gate that wrongly reached for the payload would still
      // run — Chromium blanks it until the drop, which is what this returns.
      getData: () => "",
    };
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    return { event, dataTransfer };
  }

  function dropFiles(files: File[]): DragEvent {
    const event = makeDropEvent(files);
    act(() => {
      container.dispatchEvent(event);
    });
    return event;
  }

  /**
   * A drop from the file browser (#11576): the paths arrive on a custom type
   * and there is no `File` behind any of them.
   */
  function makeInternalDropEvent(serialized: string): Event {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        files: [],
        types: [FILE_DRAG_MIME],
        dropEffect: "none",
        getData: (type: string) => (type === FILE_DRAG_MIME ? serialized : ""),
      },
    });
    return event;
  }

  function dropInternalPaths(paths: string[]): Event {
    const event = makeInternalDropEvent(encodeFileDragPaths(paths));
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
    vi.mocked(window.electron.clipboard.saveImage).mockRejectedValue(
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
    vi.mocked(window.electron.clipboard.saveImage).mockResolvedValue({
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
    let releaseSave: (value: SavedImage) => void = () => {};
    vi.mocked(window.electron.clipboard.saveImage).mockReturnValue(
      new Promise<SavedImage>((resolve) => {
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
      releaseSave({ filePath: "/tmp/late.png", thumbnailDataUrl: "" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(terminalClient.write).not.toHaveBeenCalled();
    expect(terminalInstanceService.notifyUserInput).not.toHaveBeenCalled();
  });

  it("re-reads the agent identity across the save, not the one at paste time", async () => {
    let releaseSave: (value: SavedImage) => void = () => {};
    vi.mocked(window.electron.clipboard.saveImage).mockReturnValue(
      new Promise<SavedImage>((resolve) => {
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
      releaseSave({ filePath: "/tmp/shot.png", thumbnailDataUrl: "" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(lastWrittenPayload()).toBe(`${formatAtFileToken("/tmp/shot.png")} `);
  });

  it("unmounting while the image is still saving suppresses the write", async () => {
    let releaseSave: (value: SavedImage) => void = () => {};
    vi.mocked(window.electron.clipboard.saveImage).mockReturnValue(
      new Promise<SavedImage>((resolve) => {
        releaseSave = resolve;
      })
    );

    const { unmount } = renderFileTransferHook();

    act(() => {
      container.dispatchEvent(makePasteEvent(true));
    });

    unmount();

    await act(async () => {
      releaseSave({ filePath: "/tmp/late.png", thumbnailDataUrl: "" });
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
    renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
    dropFiles([fileAt("my notes.md", `${CWD}/my notes.md`)]);

    // Pinned to the literal wire format an agent CLI has to parse, rather than
    // re-deriving it from the same formatter the hook calls — an unquoted space
    // would split the reference into two arguments.
    expect(lastWrittenPayload()).toBe('@"my notes.md" ');
  });

  it("writes the plain @ wire format for a path needing no quoting", () => {
    renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
    dropFiles([fileAt("App.tsx", `${CWD}/src/App.tsx`)]);

    expect(lastWrittenPayload()).toBe("@src/App.tsx ");
  });

  // --- The @ token agrees with every other producer (#11575) ---

  /**
   * Runs the hybrid input bar's own drop handler over the same file and returns
   * the `@file` token it inserted.
   *
   * Dropping a file on the terminal and dropping it on the input bar are one
   * gesture to the user, so the two surfaces have to spell the reference
   * identically. Comparing the producers is what catches a divergence: pinning
   * either one to its own literal passes happily while they disagree.
   */
  async function hybridInputBarToken(
    name: string,
    absolutePath: string,
    cwd: string
  ): Promise<string> {
    const dispatch = vi.fn<(transaction: { changes: { insert: string } }) => void>();
    const viewRef = {
      current: {
        state: { selection: { main: { head: 0 } } },
        dispatch,
      } as unknown as EditorView,
    };

    const { result } = renderHook(() => useDragDrop(viewRef, cwd));

    await act(async () => {
      await result.current.handleDrop({
        preventDefault: () => {},
        stopPropagation: () => {},
        dataTransfer: { files: [fileAt(name, absolutePath)], types: ["Files"] },
      } as unknown as React.DragEvent);
    });

    return dispatch.mock.calls[0]![0].changes.insert.trimEnd();
  }

  it("spells a dropped file exactly as the hybrid input bar does", async () => {
    const absolute = `${CWD}/src/App.tsx`;
    renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
    dropFiles([fileAt("App.tsx", absolute)]);

    const terminalToken = lastWrittenPayload().trimEnd();
    expect(terminalToken).toBe(await hybridInputBarToken("App.tsx", absolute, CWD));
    // …and both are the relativized spelling, not both surfaces staying absolute.
    expect(terminalToken).not.toContain(CWD);
  });

  it("spells a whitespace-bearing path exactly as the hybrid input bar does", async () => {
    const absolute = `${CWD}/src/my notes.md`;
    renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
    dropFiles([fileAt("my notes.md", absolute)]);

    expect(lastWrittenPayload().trimEnd()).toBe(
      await hybridInputBarToken("my notes.md", absolute, CWD)
    );
  });

  it("keeps a file dropped from outside the worktree absolute, like the input bar", async () => {
    const outside = "/etc/hosts.ts";
    renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
    dropFiles([fileAt("hosts.ts", outside)]);

    const terminalToken = lastWrittenPayload().trimEnd();
    expect(terminalToken).toBe(await hybridInputBarToken("hosts.ts", outside, CWD));
    // Relative would not resolve out there — absolute is the only usable form.
    expect(terminalToken).toContain(outside);
  });

  // The live PTY cwd moves as the user cd's, so the provider handed to the pane
  // on the latest commit is the one a drop has to consult — not the closure the
  // DOM listeners were registered with.
  it("relativizes against the cwd provider current at drop time", async () => {
    const absolute = `${CWD}/src/App.tsx`;
    const { rerender } = renderFileTransferHook({
      detectedAgentId: "claude",
      cwdProvider: () => "/somewhere/else",
    });

    rerender({ detectedAgentId: "claude", cwdProvider: () => CWD });
    dropFiles([fileAt("App.tsx", absolute)]);

    expect(lastWrittenPayload().trimEnd()).toBe(
      await hybridInputBarToken("App.tsx", absolute, CWD)
    );
  });

  it("leaves the shell form absolute even for a file inside the cwd", () => {
    const absolute = `${CWD}/src/App.tsx`;
    renderFileTransferHook({ cwdProvider: () => CWD });
    dropFiles([fileAt("App.tsx", absolute)]);

    // A shell resolves a relative path against its own cwd, which the pane only
    // observes — it has no way to know the two still agree.
    expect(lastWrittenPayload()).toBe(`${escapeShellArgOptional(absolute)} `);
  });

  it("relativizes a pasted image saved inside the worktree", async () => {
    vi.mocked(window.electron.clipboard.saveImage).mockResolvedValue({
      filePath: `${CWD}/.daintree/clipboard/shot.png`,
      thumbnailDataUrl: "",
    });

    renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
    await pasteImage();

    expect(lastWrittenPayload()).toBe("@.daintree/clipboard/shot.png ");
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
    const onInput = vi.fn<(data: string) => void>();
    renderFileTransferHook({ onInput, detectedAgentId: "claude" });

    dropFiles([fileAt("a.ts", "/Users/test/a.ts")]);

    const forwarded = onInput.mock.calls[0]![0];
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

  // --- In-app file drag (#11576) ---
  //
  // Only where the paths come from changes. Both axes the OS drop established
  // — content (agent `@token` vs shell-escaped absolute) and delivery
  // (bracketed paste per the live xterm mode) — have to keep deciding
  // independently, so the matrix below is the point of this block.

  describe("in-app file drag", () => {
    it("writes the agent's @token for a dragged file", () => {
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/src/App.tsx`]);

      expect(lastWrittenPayload().trimEnd()).toBe("@src/App.tsx");
    });

    // The invariant the whole feature is measured against: a dragged row and
    // an OS drop of the same file cannot disagree about what reaches the PTY.
    it("writes exactly what an OS drop of the same file writes", () => {
      const absolute = `${CWD}/src/App.tsx`;
      const { unmount } = renderFileTransferHook({
        detectedAgentId: "claude",
        cwdProvider: () => CWD,
      });
      dropFiles([fileAt("App.tsx", absolute)]);
      const fromOs = lastWrittenPayload();
      unmount();

      vi.mocked(terminalClient.write).mockClear();
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      dropInternalPaths([absolute]);

      expect(lastWrittenPayload()).toBe(fromOs);
    });

    // Content follows identity, not provenance: a shell cannot consume an
    // `@token`, and a relative path only resolves if its cwd still matches.
    it("keeps a shell's absolute escaped path", () => {
      renderFileTransferHook({ cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/src/my notes.md`]);

      expect(lastWrittenPayload().trimEnd()).toBe(escapeShellArgOptional(`${CWD}/src/my notes.md`));
    });

    it("relativizes against the cwd read at drop time", () => {
      const { rerender } = renderFileTransferHook({
        detectedAgentId: "claude",
        cwdProvider: () => "/somewhere/else",
      });
      act(() => {
        rerender({ detectedAgentId: "claude", cwdProvider: () => CWD });
      });
      dropInternalPaths([`${CWD}/src/App.tsx`]);

      expect(lastWrittenPayload().trimEnd()).toBe("@src/App.tsx");
    });

    // Delivery is the other axis and answers to the live xterm mode alone.
    it("wraps in bracketed paste when the foreground program asked for it", () => {
      instanceState.bracketedPasteMode = true;
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/src/App.tsx`]);

      expect(lastWrittenPayload()).toBe(formatWithBracketedPaste("@src/App.tsx "));
    });

    it("leaves the write unwrapped when it did not", () => {
      instanceState.bracketedPasteMode = false;
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/src/App.tsx`]);

      expect(lastWrittenPayload()).toBe("@src/App.tsx ");
    });

    // The mode is read at drop time, not captured when the listeners were
    // registered: a program that enables bracketed paste after the pane
    // mounted must still get a wrapped batch.
    it("reads the bracketed-paste mode live, not at mount", () => {
      instanceState.bracketedPasteMode = false;
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      instanceState.bracketedPasteMode = true;
      dropInternalPaths([`${CWD}/src/App.tsx`]);

      expect(lastWrittenPayload()).toBe(formatWithBracketedPaste("@src/App.tsx "));
    });

    // Content and delivery are independent. A shell in bracketed-paste mode —
    // readline enables it — must get a wrapped ABSOLUTE path, so an
    // implementation that folded the two axes into one flag fails here.
    it("wraps a shell's absolute path when the shell asked for bracketed paste", () => {
      instanceState.bracketedPasteMode = true;
      renderFileTransferHook({ cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/src/App.tsx`]);

      expect(lastWrittenPayload()).toBe(
        formatWithBracketedPaste(`${escapeShellArgOptional(`${CWD}/src/App.tsx`)} `)
      );
    });

    // With no managed instance the mode is unknown, so identity decides: an
    // agent must never be fed raw `@` keystrokes, a shell must never see the
    // delimiters as literal input.
    it("falls back to identity when no managed instance answers", () => {
      instanceState.hasManagedInstance = false;
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/src/App.tsx`]);
      expect(lastWrittenPayload()).toBe(formatWithBracketedPaste("@src/App.tsx "));

      vi.mocked(terminalClient.write).mockClear();
      renderFileTransferHook({ cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/src/App.tsx`]);
      expect(lastWrittenPayload()).toBe(`${escapeShellArgOptional(`${CWD}/src/App.tsx`)} `);
    });

    it("references a dragged folder", () => {
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/src/components`]);

      expect(lastWrittenPayload().trimEnd()).toBe("@src/components");
    });

    it("writes several dragged paths as one insertion", () => {
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/a.ts`, `${CWD}/b.ts`]);

      expect(vi.mocked(terminalClient.write)).toHaveBeenCalledTimes(1);
      expect(lastWrittenPayload().trimEnd()).toBe("@a.ts @b.ts");
    });

    it("reports the unwrapped text to input tracking", () => {
      instanceState.bracketedPasteMode = true;
      const onInput = vi.fn();
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD, onInput });
      dropInternalPaths([`${CWD}/src/App.tsx`]);

      expect(onInput).toHaveBeenCalledWith("@src/App.tsx ");
    });

    // An OS drop skips only the undeliverable path and writes the rest,
    // because its paths came from real files the user picked. This channel is
    // writable by anything that can start a drag, so a control character is
    // evidence the payload is not ours and the whole batch is refused — the
    // terminal never gets the chance to write the "good" half of a forgery.
    it("writes nothing when any path carries a terminal control character", () => {
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/we${String.fromCharCode(10)}ird.ts`, `${CWD}/fine.ts`]);

      expect(terminalClient.write).not.toHaveBeenCalled();
    });

    // ETX is the one that matters most: the line discipline raises SIGINT
    // before any shell parses the argument, so shell-escaping cannot defuse it.
    it("writes nothing for a path carrying ETX", () => {
      renderFileTransferHook({ cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/a${String.fromCharCode(3)}b.ts`]);

      expect(terminalClient.write).not.toHaveBeenCalled();
    });

    it("writes nothing while input is locked", () => {
      renderFileTransferHook({ isInputLocked: true, detectedAgentId: "claude" });
      dropInternalPaths([`${CWD}/src/App.tsx`]);

      expect(terminalClient.write).not.toHaveBeenCalled();
    });

    it("writes nothing for a malformed payload", () => {
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      act(() => {
        container.dispatchEvent(makeInternalDropEvent("not json"));
      });

      expect(terminalClient.write).not.toHaveBeenCalled();
    });

    it("never asks the OS to resolve a path it was handed", () => {
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      dropInternalPaths([`${CWD}/src/App.tsx`]);

      expect(window.electron.webUtils.getPathForFile).not.toHaveBeenCalled();
    });

    // Draining both sources would write every reference twice.
    it("prefers the in-app payload when files ride along too", () => {
      renderFileTransferHook({ detectedAgentId: "claude", cwdProvider: () => CWD });
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: {
          files: [fileAt("from-os.ts", `${CWD}/from-os.ts`)],
          types: ["Files", FILE_DRAG_MIME],
          dropEffect: "none",
          getData: () => encodeFileDragPaths([`${CWD}/src/App.tsx`]),
        },
      });
      act(() => {
        container.dispatchEvent(event);
      });

      expect(vi.mocked(terminalClient.write)).toHaveBeenCalledTimes(1);
      expect(lastWrittenPayload().trimEnd()).toBe("@src/App.tsx");
    });

    it("shows the drop affordance for the in-app type", () => {
      const { result } = renderFileTransferHook();
      const { event } = makeInternalDragEvent("dragenter");
      act(() => {
        container.dispatchEvent(event);
      });

      expect(result.current).toBe(true);
    });

    it("advertises a copy over an unlocked terminal", () => {
      renderFileTransferHook();
      const { event, dataTransfer } = makeInternalDragEvent("dragover");
      act(() => {
        container.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(dataTransfer.dropEffect).toBe("copy");
    });

    // Advertising a drop the terminal will discard is false feedback, and the
    // cursor is the only thing that says so before the gesture completes.
    it("refuses the drop with the cursor while input is locked", () => {
      renderFileTransferHook({ isInputLocked: true });
      const { event, dataTransfer } = makeInternalDragEvent("dragover");
      // Starts at "copy" so a handler that ignored the drag entirely would
      // leave it there rather than passing by accident.
      dataTransfer.dropEffect = "copy";
      act(() => {
        container.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(dataTransfer.dropEffect).toBe("none");
    });
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

  // The paste case above cannot see the four drag listeners, so dropping every
  // drag cleanup would still pass it.
  it("removes the drag listeners on unmount", () => {
    const { unmount } = renderFileTransferHook({ detectedAgentId: "claude" });
    unmount();

    const { event: over, dataTransfer } = makeInternalDragEvent("dragover");
    dataTransfer.dropEffect = "copy";
    container.dispatchEvent(over);
    container.dispatchEvent(makeInternalDropEvent(encodeFileDragPaths([`${CWD}/src/App.tsx`])));

    expect(over.defaultPrevented).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(terminalClient.write).not.toHaveBeenCalled();
  });
});
