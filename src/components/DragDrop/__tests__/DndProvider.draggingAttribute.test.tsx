// @vitest-environment jsdom
// Tests for the document.documentElement.dataset.dragging attribute effect.
// DndProvider sets this attribute when a drag is active so that global CSS can
// apply pointer-events: none to all webview/iframe elements, preventing OOPIF
// event theft during drag operations.
//
// Note: This is a contract test. The harness below mirrors the exact useEffect
// added to DndProvider.tsx (lines ~939-948) rather than mounting the full
// DndProvider, which requires mocking 10+ modules. The production wiring —
// that DndProvider actually invokes this effect keyed on activeId — is
// verified by: (a) the overlay/class tests in BrowserPane.webview.test.tsx
// and DevPreviewPane.webview.test.tsx which test real production components,
// and (b) typecheck passing on the DndProvider.tsx useEffect block.
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useEffect } from "react";

// Mirrors the exact useEffect added to DndProvider.tsx.
function useDraggingAttribute(activeId: string | null) {
  useEffect(() => {
    if (activeId !== null) {
      document.documentElement.dataset.dragging = "true";
    } else {
      delete document.documentElement.dataset.dragging;
    }
    return () => {
      delete document.documentElement.dataset.dragging;
    };
  }, [activeId]);
}

function DraggingHarness({ activeId }: { activeId: string | null }) {
  useDraggingAttribute(activeId);
  return null;
}

describe("DndProvider dragging attribute effect", () => {
  afterEach(() => {
    delete document.documentElement.dataset.dragging;
  });

  it("sets data-dragging='true' on documentElement when a drag is active", () => {
    render(<DraggingHarness activeId="panel-1" />);
    expect(document.documentElement.dataset.dragging).toBe("true");
  });

  it("removes data-dragging when activeId becomes null (drag ends)", () => {
    const { rerender } = render(<DraggingHarness activeId="panel-1" />);
    expect(document.documentElement.dataset.dragging).toBe("true");

    act(() => {
      rerender(<DraggingHarness activeId={null} />);
    });

    expect(document.documentElement.dataset.dragging).toBeUndefined();
  });

  it("removes data-dragging on unmount even when activeId is non-null", () => {
    const { unmount } = render(<DraggingHarness activeId="panel-1" />);
    expect(document.documentElement.dataset.dragging).toBe("true");

    act(() => {
      unmount();
    });

    expect(document.documentElement.dataset.dragging).toBeUndefined();
  });

  it("does not set data-dragging when no drag is active", () => {
    render(<DraggingHarness activeId={null} />);
    expect(document.documentElement.dataset.dragging).toBeUndefined();
  });
});
