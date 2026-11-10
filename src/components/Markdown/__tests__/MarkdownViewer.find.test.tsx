// @vitest-environment jsdom
import { createRef, forwardRef, useImperativeHandle, type RefObject } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { dispatchMock, codeOpenSearchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(() => Promise.resolve()),
  codeOpenSearchMock: vi.fn(),
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/components/FileViewer/CodeViewer", () => ({
  CodeViewer: forwardRef<{ openSearch: () => void }>(function CodeViewerMock(_props, ref) {
    useImperativeHandle(ref, () => ({ openSearch: codeOpenSearchMock }));
    return <div data-testid="code-viewer-mock" />;
  }),
}));

import { MarkdownViewer, type MarkdownViewerHandle } from "../MarkdownViewer";

const CONTENT = `# State management

Every store is created once per project view.

| Family | Scope |
| --- | --- |
| Preferences | app-global store |

\`\`\`ts
export const usePanelStore = create();
\`\`\`
`;

async function renderRendered() {
  const ref = createRef<MarkdownViewerHandle>();
  const before = document.createElement("button");
  before.textContent = "Tree row";
  document.body.append(before);
  render(
    <MarkdownViewer
      ref={ref}
      content={CONTENT}
      filePath="/repo/docs/state.md"
      rootPath="/repo"
      viewMode="rendered"
    />
  );
  await screen.findByRole("heading", { level: 1 });
  before.focus();
  return { ref, before };
}

async function openFind(ref: RefObject<MarkdownViewerHandle | null>) {
  act(() => ref.current!.openSearch());
  const input = await screen.findByRole("textbox", { name: "Find in document" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  return input as HTMLInputElement;
}

const count = () => screen.getByRole("status").textContent;

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("MarkdownViewer find in rendered mode (#16642)", () => {
  it("opens a focused find field that searches the rendered document", async () => {
    const { ref } = await renderRendered();
    const input = await openFind(ref);

    fireEvent.change(input, { target: { value: "store" } });
    // Paragraph, table cell, and the code block's `usePanelStore`.
    expect(count()).toBe("1 of 3");
  });

  it("steps with Enter and Shift+Enter, wrapping at both ends", async () => {
    const { ref } = await renderRendered();
    const input = await openFind(ref);
    fireEvent.change(input, { target: { value: "store" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(count()).toBe("2 of 3");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count()).toBe("1 of 3");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(count()).toBe("3 of 3");
    // Focus stays in the field while stepping.
    expect(document.activeElement).toBe(input);
  });

  it("says when nothing matches, and leaves nothing to step through", async () => {
    const { ref } = await renderRendered();
    const input = await openFind(ref);
    fireEvent.change(input, { target: { value: "zebra" } });

    expect(count()).toBe("No matches");
    expect(screen.getByRole("button", { name: "Next match" }).hasAttribute("disabled")).toBe(true);
  });

  it("narrows to the exact case with Match case", async () => {
    const { ref } = await renderRendered();
    const input = await openFind(ref);
    fireEvent.change(input, { target: { value: "Store" } });
    expect(count()).toBe("1 of 3");

    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    expect(count()).toBe("1 of 1");
  });

  it("closes on Escape and hands focus back to where the reader was", async () => {
    const { ref, before } = await renderRendered();
    const input = await openFind(ref);
    fireEvent.change(input, { target: { value: "store" } });

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    const bubbled = vi.fn();
    document.addEventListener("keydown", bubbled);
    act(() => {
      input.dispatchEvent(escape);
    });
    document.removeEventListener("keydown", bubbled);

    expect(screen.queryByRole("textbox", { name: "Find in document" })).toBeNull();
    expect(document.activeElement).toBe(before);
    // Escape stops at the bar, so a dialog around the document stays open.
    expect(bubbled).not.toHaveBeenCalled();
  });

  it("keeps Source's find on CodeMirror, with no rendered bar", () => {
    codeOpenSearchMock.mockClear();
    const ref = createRef<MarkdownViewerHandle>();
    render(
      <MarkdownViewer
        ref={ref}
        content={CONTENT}
        filePath="/repo/docs/state.md"
        rootPath="/repo"
        viewMode="source"
      />
    );

    act(() => ref.current!.openSearch());

    expect(codeOpenSearchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "Find in document" })).toBeNull();
  });
});
