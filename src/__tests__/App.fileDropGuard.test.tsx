/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useFileDropGuard } from "@/hooks/useFileDropGuard";
import { FILE_DRAG_MIME } from "@/lib/fileDragPayload";

function createDragEvent(
  type: string,
  types: string[]
): { event: Event; dataTransfer: { dropEffect: string } } {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = { dropEffect: "copy", types };
  Object.defineProperty(event, "dataTransfer", {
    value: dataTransfer,
    writable: false,
  });
  return { event, dataTransfer };
}

describe("useFileDropGuard", () => {
  afterEach(() => {
    cleanup();
  });

  it("prevents default on dragover with files", () => {
    renderHook(() => useFileDropGuard());

    const { event, dataTransfer } = createDragEvent("dragover", ["Files"]);
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");
  });

  it("prevents default on drop with files", () => {
    renderHook(() => useFileDropGuard());

    const { event } = createDragEvent("drop", ["Files"]);
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores dragover without files", () => {
    renderHook(() => useFileDropGuard());

    const { event, dataTransfer } = createDragEvent("dragover", ["text/plain"]);
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
  });

  it("ignores drop without files", () => {
    renderHook(() => useFileDropGuard());

    const { event } = createDragEvent("drop", ["text/plain"]);
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  // An in-app file drag (#11576) has to be refused on the same terms as an OS
  // one. Nothing else would claim it, so without this the cursor would keep
  // promising a copy over every surface that cannot take one.
  it("refuses an in-app file drag on dragover", () => {
    renderHook(() => useFileDropGuard());

    const { event, dataTransfer } = createDragEvent("dragover", [FILE_DRAG_MIME]);
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");
  });

  it("prevents default on an in-app file drop", () => {
    renderHook(() => useFileDropGuard());

    const { event } = createDragEvent("drop", [FILE_DRAG_MIME]);
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  // The two real destinations stop propagation, so their drops never reach
  // this listener and the guard cannot cancel a drop that was accepted.
  it("leaves a drop a destination already claimed alone", () => {
    renderHook(() => useFileDropGuard());

    const { event, dataTransfer } = createDragEvent("dragover", [FILE_DRAG_MIME]);
    event.preventDefault();
    document.dispatchEvent(event);

    expect(dataTransfer.dropEffect).toBe("copy");
  });

  it("skips events already handled by a child (defaultPrevented)", () => {
    renderHook(() => useFileDropGuard());

    const { event, dataTransfer } = createDragEvent("dragover", ["Files"]);
    // Simulate a child component calling preventDefault before bubble reaches document
    event.preventDefault();

    document.dispatchEvent(event);

    // dropEffect should remain unchanged — our handler skipped
    expect(dataTransfer.dropEffect).toBe("copy");
  });

  it("catches file drops bubbling from a child element", () => {
    renderHook(() => useFileDropGuard());

    const child = document.createElement("div");
    document.body.appendChild(child);

    const { event, dataTransfer } = createDragEvent("dragover", ["Files"]);
    child.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");

    document.body.removeChild(child);
  });

  it("removes listeners on unmount", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const { unmount } = renderHook(() => useFileDropGuard());

    expect(addSpy).toHaveBeenCalledWith("dragover", expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith("drop", expect.any(Function));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("dragover", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("drop", expect.any(Function));

    // Verify events are no longer handled after unmount
    const { event: dragEvent } = createDragEvent("dragover", ["Files"]);
    document.dispatchEvent(dragEvent);
    expect(dragEvent.defaultPrevented).toBe(false);

    const { event: dropEvent } = createDragEvent("drop", ["Files"]);
    document.dispatchEvent(dropEvent);
    expect(dropEvent.defaultPrevented).toBe(false);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
