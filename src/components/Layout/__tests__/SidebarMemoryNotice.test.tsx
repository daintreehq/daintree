// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSystemMemoryNoticeStore } from "@/store/systemMemoryNoticeStore";
import { SidebarMemoryNotice } from "../SidebarMemoryNotice";

const READING = "Swap is 91% full.";
const DETAIL = "Swap is 91% full. Restarting your Mac clears this.";

function renderRow() {
  return render(
    <TooltipProvider>
      <SidebarMemoryNotice />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
  useSystemMemoryNoticeStore.setState({ notice: null });
});

describe("SidebarMemoryNotice", () => {
  it("renders nothing while no episode is open", () => {
    const { container } = renderRow();
    expect(container.querySelector("[data-sidebar-memory-notice]")).toBeNull();
  });

  it("states the reading as a polite status line with no action when none was offered", () => {
    act(() =>
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({ reading: READING, detail: DETAIL, action: null })
    );
    const { container } = renderRow();

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe(READING);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("[data-sidebar-memory-action]")).toBeNull();
    // Ambient chrome: no accent outside the focus ring, no status colour.
    const row = container.querySelector("[data-sidebar-memory-notice]")!;
    expect(row.outerHTML).not.toMatch(/(?<!outline-)accent-primary/);
    expect(row.outerHTML).not.toMatch(/status-(warning|danger|error)/);
  });

  it("offers the diagnosis and clears when the store does", () => {
    const onClick = vi.fn();
    act(() =>
      useSystemMemoryNoticeStore.getState().setNotice({
        reading: READING,
        detail: DETAIL,
        action: { label: "Ask agent about memory", onClick },
      })
    );
    const { container } = renderRow();

    const button = container.querySelector<HTMLButtonElement>("[data-sidebar-memory-action]")!;
    expect(button.getAttribute("aria-label")).toBe("Ask agent about memory");
    expect(button.textContent).toBe("Ask agent about memory");
    // The action sits outside the live region so it isn't re-announced.
    expect(container.querySelector('[role="status"]')?.contains(button)).toBe(false);

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => useSystemMemoryNoticeStore.getState().clearNotice());
    expect(container.querySelector("[data-sidebar-memory-notice]")).toBeNull();
  });
});
