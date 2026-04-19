// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  buildAttachmentExtension,
  buildMarkdownSnippet,
  isImageMime,
  NOTES_MAX_ATTACHMENT_BYTES,
  type AttachItem,
} from "../attachmentExtension";

function makeView(extensions: ReturnType<typeof buildAttachmentExtension>[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const state = EditorState.create({ extensions });
  return new EditorView({ state, parent: container });
}

function makeFile(content: string | Uint8Array, name = "f.png", type = "image/png"): File {
  const parts: BlobPart[] =
    typeof content === "string" ? [content] : [new Blob([content as BlobPart])];
  return new File(parts, name, { type });
}

describe("buildAttachmentExtension", () => {
  it("handles paste with image items and calls onAttach", () => {
    const onAttach = vi.fn<(items: AttachItem[]) => void>();
    const view = makeView([buildAttachmentExtension({ onAttach })]);

    const file = makeFile("png-bytes", "shot.png", "image/png");
    const clipboardData = {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => file,
        },
      ] as unknown as DataTransferItemList,
    } as DataTransfer;

    const event = new Event("paste") as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: clipboardData });

    view.contentDOM.dispatchEvent(event);

    expect(onAttach).toHaveBeenCalledTimes(1);
    const args = onAttach.mock.calls[0]![0];
    expect(args.length).toBe(1);
    expect(args[0]!.mimeType).toBe("image/png");
    expect(args[0]!.originalName).toBe("shot.png");
    view.destroy();
  });

  it("does not call onAttach when paste contains only text", () => {
    const onAttach = vi.fn();
    const view = makeView([buildAttachmentExtension({ onAttach })]);

    const clipboardData = {
      items: [
        {
          kind: "string",
          type: "text/plain",
          getAsFile: () => null,
        },
      ] as unknown as DataTransferItemList,
      getData: () => "",
      types: ["text/plain"],
    } as unknown as DataTransfer;

    const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    view.contentDOM.dispatchEvent(event);

    expect(onAttach).not.toHaveBeenCalled();
    view.destroy();
  });

  it("rejects oversized files via onRejected", () => {
    const onAttach = vi.fn();
    const onRejected = vi.fn();
    const view = makeView([buildAttachmentExtension({ onAttach, onRejected })]);

    const bigFile = makeFile(new Uint8Array(1), "huge.png", "image/png");
    Object.defineProperty(bigFile, "size", { value: NOTES_MAX_ATTACHMENT_BYTES + 1 });
    const clipboardData = {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => bigFile,
        },
      ] as unknown as DataTransferItemList,
    } as DataTransfer;

    const event = new Event("paste") as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    view.contentDOM.dispatchEvent(event);

    expect(onAttach).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected.mock.calls[0]![1]).toBe("oversize");
    view.destroy();
  });

  it("collects dropped files in original order", () => {
    const onAttach = vi.fn<(items: AttachItem[]) => void>();
    const view = makeView([buildAttachmentExtension({ onAttach })]);

    const files = [
      makeFile("a", "one.png", "image/png"),
      makeFile("bb", "two.pdf", "application/pdf"),
    ];

    const dataTransfer = {
      files: Object.assign(files, {
        item: (i: number) => files[i] ?? null,
        length: files.length,
      }) as unknown as FileList,
      types: ["Files"],
    } as unknown as DataTransfer;

    const event = new Event("drop") as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    view.contentDOM.dispatchEvent(event);

    expect(onAttach).toHaveBeenCalledTimes(1);
    const items = onAttach.mock.calls[0]![0];
    expect(items.length).toBe(2);
    expect(items[0]!.originalName).toBe("one.png");
    expect(items[1]!.originalName).toBe("two.pdf");
    view.destroy();
  });
});

describe("buildMarkdownSnippet", () => {
  it("uses image syntax for image MIME types", () => {
    const snippet = buildMarkdownSnippet(
      { mimeType: "image/png", originalName: "screenshot.png" },
      "attachments/abc.png"
    );
    expect(snippet).toBe("![screenshot](attachments/abc.png)");
  });

  it("uses link syntax for non-image MIME types", () => {
    const snippet = buildMarkdownSnippet(
      { mimeType: "application/pdf", originalName: "spec.pdf" },
      "attachments/abc.pdf"
    );
    expect(snippet).toBe("[spec.pdf](attachments/abc.pdf)");
  });

  it("defaults to 'image' alt when filename has no base", () => {
    const snippet = buildMarkdownSnippet(
      { mimeType: "image/png", originalName: ".png" },
      "attachments/x.png"
    );
    expect(snippet).toBe("![image](attachments/x.png)");
  });

  it("escapes whitespace in URLs", () => {
    const snippet = buildMarkdownSnippet(
      { mimeType: "image/png", originalName: "file name.png" },
      "attachments/has space.png"
    );
    expect(snippet).toContain("%20");
    expect(snippet).not.toContain("has space");
  });

  it("sanitizes newlines and brackets from alt text", () => {
    const snippet = buildMarkdownSnippet(
      { mimeType: "image/png", originalName: "bad\nname].png" },
      "attachments/x.png"
    );
    expect(snippet.includes("\n")).toBe(false);
    expect(snippet.includes("]")).toBe(snippet.endsWith(")"));
  });

  it("escapes opening brackets in link labels", () => {
    const snippet = buildMarkdownSnippet(
      { mimeType: "application/pdf", originalName: "spec[final].pdf" },
      "attachments/x.pdf"
    );
    // Must be a valid CommonMark link: no unescaped [ or ] inside the label.
    const labelMatch = snippet.match(/^\[(.*)\]\(/);
    expect(labelMatch).not.toBeNull();
    const label = labelMatch![1]!;
    expect(label.includes("[")).toBe(false);
    expect(label.includes("]")).toBe(false);
  });
});

describe("isImageMime", () => {
  it("detects image types", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("IMAGE/JPEG")).toBe(true);
  });

  it("rejects non-image types", () => {
    expect(isImageMime("application/pdf")).toBe(false);
    expect(isImageMime("text/plain")).toBe(false);
  });
});
