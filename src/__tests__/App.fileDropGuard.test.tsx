/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useEffect } from "react";

/**
 * Extracted copy of the drag-guard hook from App.tsx for isolated testing.
 * This avoids mounting the full App component with all its dependencies.
 */
function useFileDropGuard() {
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    };

    const handleDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
    };

    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDrop);

    return () => {
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDrop);
    };
  }, []);
}

function createDragEvent(
  type: string,
  types: string[],
): { event: Event; dataTransfer: { dropEffect: string } } {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = { dropEffect: "copy", types };
  Object.defineProperty(event, "dataTransfer", {
    value: dataTransfer,
    writable: false,
  });
  return { event, dataTransfer };
}

describe("file drop guard", () => {
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
    const { event } = createDragEvent("dragover", ["Files"]);
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
